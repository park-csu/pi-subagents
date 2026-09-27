import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
// Keep helpers on Pi's uncached TypeScript loader path so /reload refreshes them.
import { open, mkdir, mkdtemp, writeFile, realpath, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { writeSync } from "node:fs";
import { ActivityTracker } from "./activity.ts";
import { openWorkerPane } from "./tmux.ts";
import { observationSnapshot } from "./observation.ts";
import { WorkerLifecycle } from "./lifecycle.ts";
import { createWorkerRpc } from "./rpc.ts";
import { DEFAULT_LIMITS, validateLimits } from "./limits.ts";
import type { WorkerHandle, WorkerStarted, WorkerResult, WorkerDefinition, WorkerUsage, WorkerOptions } from "./worker-types.ts";

export const DELEGATION_TOOLS = ["delegate", "delegate_message"];

export function validateTask(task: unknown): asserts task is string {
  if (typeof task !== "string" || !task.trim()) throw new Error("Task must be a nonempty string");
  if (Buffer.byteLength(task, "utf8") > 128000) throw new Error("Task exceeds 128KB; use focused instructions and document paths");
}

export function resolveTools(requested, allTools, activeNames) {
  const extensions = new Set();
  for (const name of requested) {
    const tool = allTools.find((entry) => entry.name === name);
    if (!tool || !activeNames.includes(name)) throw new Error(`Tool unavailable in parent: ${name}`);
    if (tool.sourceInfo?.source === "builtin") continue;
    const path = tool.sourceInfo?.path;
    if (!path || !isAbsolute(path)) throw new Error(`Cannot load tool source in child: ${name}`);
    extensions.add(path);
  }
  return [...extensions];
}

export function validateDelegatableAgents(value) {
  if (!Array.isArray(value) || value.length > 64 ||
      value.some(name => typeof name !== "string" || !/^[a-z][a-z0-9-]*$/.test(name))) {
    throw new Error("delegatable_agents must be an explicit array of at most 64 role names");
  }
  return [...new Set(value)];
}

export function validateDefinition(frontmatter, body, filename): WorkerDefinition {
  const allowed = new Set(["name", "description", "model", "thinking", "callable", "can_delegate", "delegatable_agents", "tools"]);
  for (const key of Object.keys(frontmatter)) {
    if (!allowed.has(key)) throw new Error(`${filename}: unknown field ${key}`);
  }
  const definition = { ...frontmatter, systemPrompt: body.trim() };
  for (const key of ["name", "description", "model", "thinking", "systemPrompt"]) {
    if (typeof definition[key] !== "string" || !definition[key].trim()) {
      throw new Error(`${filename}: ${key} must be a nonempty string`);
    }
  }
  if (!/^[a-z][a-z0-9-]*$/.test(definition.name)) throw new Error(`${filename}: invalid name`);
  if (!/^[^/\s]+\/[^\s]+$/.test(definition.model)) throw new Error(`${filename}: use provider/model`);
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(definition.thinking)) {
    throw new Error(`${filename}: invalid thinking`);
  }
  for (const key of ["callable", "can_delegate"]) {
    if (typeof definition[key] !== "boolean") throw new Error(`${filename}: ${key} must be a boolean`);
  }
  const delegatableAgents = validateDelegatableAgents(definition.delegatable_agents ?? []);
  if (definition.can_delegate !== (delegatableAgents.length > 0)) {
    throw new Error(`${filename}: can_delegate must match a nonempty delegatable_agents list`);
  }
  const tools = definition.tools;
  if (!Array.isArray(tools) || tools.some((tool) =>
    typeof tool !== "string" || !/^[a-z][a-z0-9_]*$/.test(tool) || DELEGATION_TOOLS.includes(tool) || tool === "finish_task")) {
    throw new Error(`${filename}: tools must be an explicit array of tool names; use can_delegate for delegate`);
  }
  return { ...definition, delegatable_agents: delegatableAgents, tools: [...new Set(tools)] };
}

export function authorize(agent, { manual = false, depth = 0, canDelegate = true, maxDepth = 2, delegatableAgents = undefined } = {}) {
  if (!Number.isInteger(depth) || depth < 0 || depth >= maxDepth) throw new Error("Subagent depth limit reached");
  if (!canDelegate) throw new Error("This agent cannot delegate");
  if (delegatableAgents !== undefined && !delegatableAgents.includes(agent.name)) {
    throw new Error(`Delegation to ${agent.name} is not permitted by delegatable_agents`);
  }
  if (!manual && !agent.callable) throw new Error(`${agent.name} is manual-only`);
}

export function childArgs(agent, extensionPath, promptPath, toolExtensions = [], allowDelegate = agent.can_delegate && agent.delegatable_agents?.length > 0, terminal = false, sessionFile, transport = "json") {
  return [
    ...(terminal ? [] : transport === "rpc" ? ["--mode", "rpc"] : ["--mode", "json", "-p"]),
    ...(sessionFile ? ["--session", sessionFile] : ["--no-session"]), "--no-approve",
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "-e", extensionPath,
    ...[...new Set(toolExtensions)].filter((path) => path !== extensionPath).flatMap((path) => ["-e", path]),
    "--model", agent.model, "--thinking", agent.thinking,
    "--tools", [...agent.tools, ...(allowDelegate ? DELEGATION_TOOLS : []), "finish_task"].join(","),
    "--append-system-prompt", promptPath,
  ];
}

export function emptyUsage(): WorkerUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function addUsage(total, usage) {
  if (!usage) return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    total[key] += Number.isFinite(usage[key]) ? usage[key] : 0;
  }
  for (const key of Object.keys(total.cost)) {
    total.cost[key] += Number.isFinite(usage.cost?.[key]) ? usage.cost[key] : 0;
  }
}

// Process isolation is not a security sandbox. Only run trusted local tasks.
// Use pi's supported JSON events: ordinary extension stdout is redirected to
// stderr in JSON mode. The parent validates/sanitizes these display-only data.
export function descendantProgress(event) {
  if (event.toolName !== "delegate") return [];
  const details = (event.type === "tool_execution_update" ? event.partialResult
    : event.type === "tool_execution_end" ? event.result : undefined)?.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  return [details, ...(Array.isArray(details.descendants) ? details.descendants.slice(0, 256) : [])];
}

// The handle exists before asynchronous setup, so shutdown can stop startup too.
export function startWorker(options: WorkerOptions): WorkerHandle {
  const lifecycle = new WorkerLifecycle();
  const startupAbort = new AbortController();
  let controls;
  let resolveReady: (started: WorkerStarted) => void;
  let rejectReady: (error: unknown) => void;
  const ready = new Promise<WorkerStarted>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const done = executeWorker({ ...options, startupSignal: startupAbort.signal }, {
    lifecycle,
    started: value => resolveReady(value),
    failed: error => rejectReady(error),
    control: value => { controls = value; },
  }).finally(() => { lifecycle.move("ended"); });
  done.then(() => rejectReady(new Error("Worker ended before session startup")), rejectReady);
  // Callers may observe ready and done at different times.
  ready.catch(() => {});
  done.catch(() => {});
  return {
    get phase() { return lifecycle.phase; },
    ready, done,
    stop() {
      if (controls) controls.stop();
      else { lifecycle.move("stopping"); startupAbort.abort(); }
    },
    interrupt() {
      if (controls) return controls.interrupt();
      else { lifecycle.move("stopping"); startupAbort.abort(); }
    },
    resume(message) { return controls?.resume(message); },
    message(text) {
      if (!controls) throw new Error("Worker is starting; wait for its startup acknowledgement");
      return controls.message(text);
    },
    control(request) {
      if (!controls) throw new Error("Worker is starting");
      return controls.control(request);
    },
  };
}

// Convenience for callers that only need the final result. Pause never settles it.
export function runChild(options: WorkerOptions) {
  return startWorker({ waitForSession: false, ...options }).done;
}

async function executeWorker({
  agent, task, contract, cwd, runsDir, extensionPath, depth = 0, signal, onProgress,
  command = "pi", prefix = [], killGraceMs = 2000,
  maxOutputBytes = 16 * 1024 * 1024,
  toolExtensions = [],
  limits = DEFAULT_LIMITS, pool = "", runId = "", parentRunId = "",
  onDescendant, useTmux = false, onPaneError, resumeSession, onPrepared, originalTask = task,
  waitForSession = true, startupSignal, ticketsEnabled = false, transport = "rpc",
}: WorkerOptions & { startupSignal: AbortSignal }, runtime): Promise<WorkerResult> {
  const { lifecycle } = runtime;
  limits = validateLimits(limits);
  startupSignal.throwIfAborted();
  signal?.throwIfAborted();
  await mkdir(runsDir, { recursive: true, mode: 0o700 });
  const runDir = await mkdtemp(join(runsDir, `${agent.name}-`));
  const sessionFile = resumeSession || join(runDir, "session.jsonl");
  await writeFile(join(runDir, "loadout.json"), JSON.stringify({
    version: 2, agent, task: originalTask, contract, cwd: await realpath(cwd), toolExtensions, limits, sessionFile,
  }), { mode: 0o600 });
  await onPrepared?.({ runDir, sessionFile });
  const promptPath = join(runDir, "prompt.md");
  await writeFile(promptPath, agent.systemPrompt, { mode: 0o600 });
  await writeFile(join(runDir, "handoff.txt"), task, { mode: 0o600 });
  const log = await open(join(runDir, "events.jsonl"), "wx", 0o600);
  let pane;
  let transportDir;
  let sessionLocked = false;
  let resultWrites = Promise.resolve(), terminalSaved = false;
  const saveResult = result => {
    if (result.status === "paused" && terminalSaved) return resultWrites;
    if (result.status !== "paused") terminalSaved = true;
    const text = JSON.stringify(result, null, 2);
    resultWrites = resultWrites.catch(() => {}).then(() =>
      writeFile(join(runDir, "result.json"), text, { mode: 0o600 }));
    return resultWrites;
  };
  const cleanup = async () => {
    try { await log.close(); } finally {
      try { await pane?.close(); } finally {
        try { if (transportDir) await rm(transportDir, { recursive: true, force: true }); }
        finally { if (sessionLocked) await rm(sessionFile + ".lock", { recursive: true, force: true }); }
      }
    }
  };
  try {
    pane = useTmux ? await openWorkerPane({ pool, runId, parentRunId, onError: onPaneError }) : undefined;
    if (pane) transportDir = await mkdtemp(join(tmpdir(), "pi-tmux-"));
    startupSignal.throwIfAborted();
    try { await mkdir(sessionFile + ".lock", { mode: 0o700 }); }
    catch (error) {
      if (error.code === "EEXIST") throw new Error("Worker session is already owned; concurrent restore is forbidden");
      throw error;
    }
    sessionLocked = true;
    startupSignal.throwIfAborted();
    signal?.throwIfAborted();
    const usage = emptyUsage();
    const started = Date.now();
    const tracker = new ActivityTracker();
    let lastProgress = 0;
    let observation = observationSnapshot(undefined);
    const progress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastProgress < 200) return;
      lastProgress = now;
      // Observability callbacks must never interrupt worker execution.
      try { onProgress?.({ observation, turns, usage: structuredClone(usage), elapsedMs: now - started, runDir, ...tracker.snapshot() }); }
      catch { /* UI may have detached during shutdown. */ }
    };
    let output = "", lastText = "", stderr = "", stopReason, failure, bytes = 0, turns = 0;
    let handoffReport: string | undefined;
    let terminalExitReceived = false;
    progress(true);
    startupSignal.throwIfAborted();
    const result: WorkerResult = await new Promise((resolve) => {
      const allowDelegate = agent.can_delegate && agent.delegatable_agents?.length > 0 && depth + 1 < limits.max_depth;
      const rpcMode = !pane && transport === "rpc";
      const persistent = Boolean(pane) || rpcMode;
      const args = [...prefix, ...childArgs(agent, extensionPath, promptPath, toolExtensions, allowDelegate, Boolean(pane), sessionFile, transport)];
      const proc = spawn(pane ? process.execPath : command, pane
        ? [fileURLToPath(new URL("./tmux-worker.mjs", import.meta.url)), "--supervise", pane.pane, transportDir, command, ...args]
        : args, {
        // Headless workers inherit the top-level group. For TUI workers this
        // process is only the relay; disconnecting it ends the tmux-owned group.
        cwd, shell: false, detached: process.platform !== "win32" && depth === 0,
        stdio: pane ? ["ignore", "ignore", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe", "pipe"],
        env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
          PI_SUBAGENT_DEPTH: String(depth + 1),
          PI_SUBAGENT_TICKETS: ticketsEnabled ? "on" : "off",
          PI_SUBAGENT_CAN_DELEGATE: String(allowDelegate),
          PI_SUBAGENT_DELEGATABLE_AGENTS: JSON.stringify(allowDelegate ? agent.delegatable_agents : []),
          PI_SUBAGENT_LIMITS: JSON.stringify(limits), PI_SUBAGENT_POOL: pool,
          PI_SUBAGENT_RUN_ID: runId, PI_SUBAGENT_PARENT_RUN_ID: parentRunId,
          PI_SUBAGENT_MODEL: agent.model, PI_SUBAGENT_THINKING: agent.thinking,
          PI_SUBAGENT_TUI: pane ? "1" : "0",
          PI_SUBAGENT_RPC: rpcMode ? "1" : "0",
          PI_SUBAGENT_HANDOFF: join(runDir, "handoff.txt"),
          PI_SUBAGENT_TMUX_MAIN: pane?.main || process.env.PI_SUBAGENT_TMUX_MAIN || "",
          TMUX_PANE: pane?.pane || process.env.TMUX_PANE,
          PI_SUBAGENT_TOOLS: JSON.stringify([...agent.tools, ...(allowDelegate ? DELEGATION_TOOLS : []), "finish_task"]) },
      });
      const rpc = rpcMode ? createWorkerRpc(wire => proc.stdin.write(wire)) : undefined;
      const rpcControl = request => rpc.request(id => ({ type: "prompt",
        message: `/worker-control ${JSON.stringify({ ...request, id })}` }), "worker_control_result");
      let escalation;
      const sessionReady = () => {
        if (lifecycle.phase === "stopping" || lifecycle.phase === "ended") return;
        if (lifecycle.phase === "starting") lifecycle.move("running");
        runtime.started({ runDir, sessionFile });
      };
      proc.once("spawn", () => { if (!waitForSession) sessionReady(); });
      proc.once("error", runtime.failed);
      const kill = (sig) => {
        try {
          if (process.platform === "win32" || depth > 0) proc.kill(sig);
          else if (proc.pid) process.kill(-proc.pid, sig);
        } catch (error) { if (error.code !== "ESRCH") failure ??= error.message; }
      };
      const stop = (reason) => {
        failure ??= reason;
        if (!lifecycle.move("stopping")) return;
        kill("SIGTERM");
        escalation = setTimeout(() => kill("SIGKILL"), killGraceMs);
      };
      let resumeRequested = false;
      const abort = () => {
        if (lifecycle.phase === "ended" || lifecycle.phase === "stopping") return;
        if (!persistent) { stop("cancelled"); return; }
        if (rpc) return rpcControl({ type: "interrupt" });
        // Interrupt the Pi turn, not the process or its terminal.
        proc.stdio[4].write("interrupt\n");
      };
      const hardAbort = () => stop("cancelled");
      startupSignal.addEventListener("abort", hardAbort, { once: true });
      const signalAbort = () => { Promise.resolve(abort()).catch(error => stop(error.message)); };
      signal?.addEventListener("abort", signalAbort, { once: true });
      if (signal?.aborted) signalAbort();
      const snapshot = (status, error = failure, text = output) => ({
        runId, parentRunId, depth: depth + 1, startedAt: started, status,
        error, output: error && !text.trim() ? lastText : text,
        observation, partialOutput: Boolean(error),
        usage: structuredClone(usage), turns, runDir,
        elapsedMs: Date.now() - started, sessionFile, ...tracker.snapshot(),
      });
      const line = (text) => {
        if (!text.trim()) return;
        // Serialize complete records, not interleaved chunks from stdout/FD 3.
        try { writeSync(log.fd, text + "\n"); }
        catch (error) { stop(`Cannot write child log: ${error.message}`); return; }
        let event;
        try { event = JSON.parse(text); } catch { stop("Invalid child JSON stream"); return; }
        if (!event || typeof event.type !== "string") { stop("Invalid child event"); return; }
        if (rpc?.receive(event)) return;
        if (persistent && event.type === "agent_start" && lifecycle.phase !== "stopping") {
          failure = undefined;
          stopReason = undefined;
        }
        if (rpc && event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
          proc.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true }) + "\n");
          return;
        }
        if (pane && event.type === "tmux_worker_exit") {
          terminalExitReceived = true; // Distinguish a worker exit from manual pane closure.
          return;
        }
        observation = { state: "current", lastEventAt: Date.now() };
        if (event.type === "worker_ready") { sessionReady(); progress(true); return; }
        if (event.type === "worker_task_done") {
          if (typeof event.report !== "string" || !event.report.trim() || event.report.length > 12000 ||
              handoffReport !== undefined) {
            stop("Invalid or duplicate finish_task handoff");
            return;
          }
          handoffReport = event.report;
          return;
        }
        if (persistent && event.type === "worker_paused") {
          if (!lifecycle.move("paused")) return;
          resumeRequested = false;
          signal?.removeEventListener("abort", signalAbort);
          const result = snapshot("paused", undefined, "Paused. Resume from /subagents.");
          result.error = undefined;
          try { onProgress?.({ ...result, activity: "Paused — resume from /subagents" }); } catch {}
          void saveResult(result).catch(error => stop(`Cannot save result: ${error.message}`));
          return;
        }
        if (persistent && event.type === "worker_resumed") {
          if (!lifecycle.move("running")) return;
          resumeRequested = false;
          failure = undefined;
          stopReason = undefined;
          try { onProgress?.({ status: "running", error: undefined, observation }); } catch {}
          return;
        }
        if (event.type === "worker_resume_failed") {
          try { onProgress?.({ activity: "Resume failed", error: event.error }); } catch {}
          return;
        }
        if (event.type === "worker_compaction") {
          if (lifecycle.phase === "stopping" || lifecycle.phase === "ended") return;
          if (event.phase === "completed" && !event.userInterrupted) {
            failure = undefined;
            stopReason = undefined;
          }
          if (event.phase === "completed") addUsage(usage, event.usage);
          try { onProgress?.({ observation, activity: event.phase === "started" ? "Compacting context" :
            event.phase === "completed" ? "Context compacted" : "Compaction failed" }); } catch {}
          return;
        }
        if (event.type === "worker_progress") {
          try { onDescendant?.(event.info); } catch {}
          progress();
          return;
        }
        for (const info of descendantProgress(event)) {
          // UI-only metadata. Never interpret it as approval, usage or tool policy.
          try { onDescendant?.(info); } catch { /* Parent UI may be detached. */ }
        }
        if (tracker.update(event)) progress(event.type !== "message_update");
        const message = event.message;
        if (event.type === "message_end" && message?.role === "assistant") {
          turns++;
          addUsage(usage, message.usage);
          output = (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
          if (output.trim()) lastText = output;
          stopReason = message.stopReason;
          if (["error", "aborted"].includes(stopReason)) failure ??= message.errorMessage || stopReason;
          progress(true);
        } else if (event.type === "message_end" && message?.role === "toolResult") {
          addUsage(usage, message.usage);
        } else if (event.type === "message_end" && message?.role === "custom" &&
            message.customType === "subagent-completion") {
          addUsage(usage, message.details?.usage);
        }
        progress();
      };
      // Each channel has its own decoder; all channels share the byte budget.
      const attachEvents = stream => {
        let buffer = "";
        stream.setEncoding("utf8");
        stream.on("data", chunk => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > maxOutputBytes) { stop("Output limit reached"); return; }
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            line(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
          }
        });
        return () => { if (buffer.trim()) line(buffer); };
      };
      const flushEvents = [attachEvents(pane ? proc.stdio[3] : proc.stdout)];
      if (!pane) {
        flushEvents.push(attachEvents(proc.stdio[3]));
        proc.stdin.on("error", () => {}); // Early startup failure can close stdin.
        if (rpc) void rpc.request({ type: "prompt", message: task }).catch(error => stop(`Worker startup: ${error.message}`));
        else proc.stdin.end(task);
      }
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
      proc.stdio[4].on("error", () => {}); // Closed child cannot accept interrupts.
      proc.stdio[4].resume(); // Drain EOF so ChildProcess.close can fire.
      proc.on("error", (error) => { failure ??= error.message; });
      proc.once("close", (code, exitSignal) => {
        lifecycle.move("ended");
        clearTimeout(escalation);
        if (depth === 0) kill("SIGKILL"); // Reap leftover subtree processes even on a clean leader exit.
        rpc?.close();
        signal?.removeEventListener("abort", signalAbort);
        startupSignal.removeEventListener("abort", hardAbort);
        for (const flush of flushEvents) flush();
        if (pane && code !== 0 && !terminalExitReceived) {
          try { pane.size(); } catch { failure ??= "cancelled"; }
        }
        if (code !== 0) failure ??= `Child exited ${code ?? exitSignal}: ${stderr}`;
        runtime.failed(new Error(failure || "Worker ended before session startup"));
        if (handoffReport !== undefined) output = handoffReport;
        else failure ??= "Child exited without calling finish_task";
        const status = !failure ? "completed"
          : failure === "cancelled" || stopReason === "aborted" ? "cancelled" : "failed";
        const final = snapshot(status);
        resolve(final);
      });
      const sendCommand = (type, prompt) => {
        if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16000) {
          throw new Error("Worker message must contain 1–16000 characters");
        }
        const wire = JSON.stringify({ type, prompt }) + "\n";
        if (Buffer.byteLength(wire) > 60000) throw new Error("Encoded worker message exceeds 60KB");
        if (lifecycle.phase === "ended" || lifecycle.phase === "stopping") throw new Error("Worker has ended");
        if (rpc) return rpcControl({ type, prompt });
        proc.stdio[4].write(wire);
      };
      runtime.control({
        stop: () => stop("cancelled"),
        interrupt: abort,
        message: prompt => sendCommand("message", prompt),
        control: request => {
          if (!rpc) throw new Error("Worker does not support routed controls");
          return rpcControl({ type: "control", ...request });
        },
        resume: (prompt = "Continue the original delegated task.") => {
          if (!persistent || lifecycle.phase !== "paused" || resumeRequested) return;
          resumeRequested = true;
          try {
            const result = sendCommand("resume", prompt);
            if (result) return result.catch(error => { resumeRequested = false; throw error; });
          } catch (error) { resumeRequested = false; throw error; }
        },
      });
    });
    await saveResult(result);
    return result;
  } finally {
    await cleanup();
  }
}
