import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, sep, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { authorize, startWorker, validateDefinition, validateDelegatableAgents, validateTask, resolveTools, DELEGATION_TOOLS } from "./core.ts";
import { progressLine, displayText, workerPreview } from "./activity.ts";
import { loadLimits, createPool, acquireWorkerSlots, validateLimits } from "./limits.ts";
import { resumePrompt } from "./state.ts";
import { createLogReader } from "./logs.ts";
import { workerName, readLoadout } from "./session-store.ts";
import type { WorkerHandle, SavedLoadout } from "./worker-types.ts";

import type { DelegationContract } from "./contract.ts";

type InvocationOptions = {
  role: string;
  task: string;
  ctx: any;
  manual?: boolean;
  signal?: AbortSignal;
  onUpdate?: any;
  goal?: string;
  name?: string;
  saved?: SavedLoadout;
  mode?: "sync" | "async";
  contract?: DelegationContract;
  parallelWork?: string;
};

export function createDispatcher(pi, { extensionPath, states, widget, getTicketsEnabled = (_ctx) => false }) {
  const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? 0);
  const delegatableAgents = depth > 0
    ? validateDelegatableAgents(JSON.parse(process.env.PI_SUBAGENT_DELEGATABLE_AGENTS ?? "[]")) : undefined;
  const canDelegate = depth === 0 ||
    (process.env.PI_SUBAGENT_CAN_DELEGATE === "true" && delegatableAgents.length > 0);
  const limits = loadLimits(getAgentDir(), depth > 0 ? process.env.PI_SUBAGENT_LIMITS : undefined);
  const parentRunId = depth > 0 ? process.env.PI_SUBAGENT_RUN_ID || "" : "";
  const parentIdentity = depth === 0 ? "root" : parentRunId;
  let poolPromise: Promise<string> | undefined;
  const runsDir = join(getAgentDir(), "subagent-runs");
  function getPool() {
    if (depth > 0) {
      if (!process.env.PI_SUBAGENT_POOL) throw new Error("Nested worker has no shared concurrency pool");
      return Promise.resolve(process.env.PI_SUBAGENT_POOL);
    }
    return poolPromise ??= createPool(runsDir);
  }
  const active = new Map<AbortController, { done: Promise<void>; stop: () => void; interrupt: () => void;
    resume: (message?: string) => any; message: (message: string) => any; info: () => any;
    control: (request: any) => any; descendants: () => Map<string, any>; controlError: (error: any) => void }>();
  const records = new Map<string, any>();
  const readLog = createLogReader(runsDir, { structured: true });
  const restoring = new Set<string>();
  let shuttingDown = false;
  let suspended = false;
  function interruptAll() {
    pi.events.emit("subagents:user-interrupt", {});
    suspended = true;
    return Promise.allSettled([...active.values()].map(worker =>
      Promise.resolve(worker.interrupt()).catch(worker.controlError)));
  }
  function resumePaused() {
    suspended = false;
    for (const worker of active.values()) {
      if (worker.info().status === "paused") Promise.resolve(worker.resume()).catch(worker.controlError);
    }
  }
  async function restoreSession(ctx) {
    records.clear();
    states.records.clear();
    states.invalidators.clear();
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === "subagent-run") {
        const row = entry.data;
        if (row?.deleted && typeof row.name === "string") records.delete(row.name);
        else if (row && typeof row.name === "string" && typeof row.runDir === "string" &&
            typeof row.role === "string" && typeof row.runId === "string") {
          try { workerName(new Map(), row.role, row.name); records.set(row.name, row); } catch {}
        }
      }
      if (entry.type !== "custom" || entry.customType !== "subagent-state") continue;
      const preview = workerPreview(entry.data);
      if (preview) states.update({ ...preview, output: String(entry.data.output ?? "").slice(0, 12000),
        runDir: entry.data.runDir });
    }
    // Repair historical paused cards from versions that did not persist final
    // lifecycle updates. Read only bounded, contained, matching run artifacts.
    const wanted = new Map<string, any>();
    for (const entry of branch) {
      const details = entry.message?.toolName === "delegate" ? entry.message.details : undefined;
      if (details?.status !== "paused") continue;
      for (const row of [details, ...(details.descendants ?? [])]) wanted.set(row.runId, row);
    }
    if (wanted.size) {
      try {
        const root = await realpath(runsDir);
        for (const name of (await readdir(root)).slice(-2048)) {
          try {
            const file = await realpath(join(root, name, "result.json"));
            const metadata = await stat(file);
            if (!file.startsWith(root + sep) || !metadata.isFile() || metadata.size > 1024 * 1024) continue;
            const result = JSON.parse(await readFile(file, "utf8"));
            const original = wanted.get(result.runId);
            if (!original) continue;
            const preview = workerPreview({ ...original, ...result });
            if (preview) states.update({ ...preview, wasPaused: original.status === "paused", output: String(result.output ?? "").slice(0, 12000),
              runDir: result.runDir });
          } catch { /* Missing, invalid or untrusted artifact. */ }
        }
      } catch { /* No artifact directory yet. */ }
    }
    if (depth === 0) {
      for (const row of states.records.values()) {
        if (!["running", "paused"].includes(row.status)) widget.update(row);
      }
    }
  }
  function listWorkers() {
    const rows = new Map<string, any>();
    for (const [id, row] of states.records) rows.set(id, { ...row, restored: true });
    for (const [id, row] of widget.workers) rows.set(id, { ...rows.get(id), ...row, restored: false });
    for (const record of records.values()) {
      if (rows.has(record.runId)) rows.set(record.runId, { ...record, ...rows.get(record.runId),
        runDir: record.runDir, name: record.name });
    }
    for (const worker of active.values()) {
      const info = worker.info();
      rows.set(info.runId, { ...rows.get(info.runId), ...info, restored: false });
    }
    for (const row of rows.values()) {
      const live = [...active.values()].find(worker => worker.info().runId === row.runId);
      const owner = [...active.values()].find(worker => worker.descendants().has(row.runId));
      const saved = [...records.values()].some(record => record.runId === row.runId && record.runDir);
      row.canMessage = Boolean(live || owner || saved);
      row.canPause = Boolean((live || owner) && !row.restored && row.status === "running");
      row.canResume = Boolean(row.canMessage && (row.restored || row.status !== "running"));
    }
    const priority = row => !row.restored && row.status === "running" ? 0 : !row.restored && row.status === "paused" ? 1 : 2;
    return [...rows.values()].sort((a, b) => priority(a) - priority(b));
  }

  async function discover() {
    const dir = join(getAgentDir(), "subagents");
    let files: string[];
    try { files = await readdir(dir); }
    catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
    const agents = [];
    for (const file of files.sort().filter((f) => f.endsWith(".md"))) {
      const { frontmatter, body } = parseFrontmatter(await readFile(join(dir, file), "utf8"));
      const agent = validateDefinition(frontmatter, body, file);
      if (agents.some((a) => a.name === agent.name)) throw new Error(`Duplicate subagent: ${agent.name}`);
      agents.push(agent);
    }
    return agents;
  }

  async function invoke({
    role, task, ctx, manual = false, signal, onUpdate, goal = "", name: requestedName, saved, mode = "sync", contract = saved?.contract, parallelWork,
  }: InvocationOptions) {
    const ticketsEnabled = getTicketsEnabled(ctx);
    if (mode !== "sync" && mode !== "async") throw new Error("mode must be sync or async");
    validateTask(task);
    if (mode === "async" && !manual && !saved &&
        (typeof parallelWork !== "string" || !parallelWork.trim() || parallelWork.length > 2000)) {
      throw new Error("async requires parallel_work describing independent parent/sibling work; otherwise use sync");
    }
    const current = (await discover()).find((a) => a.name === role);
    if (!current) throw new Error(`Unknown subagent: ${role}`);
    authorize(current, { manual, depth, canDelegate, delegatableAgents, maxDepth: limits.max_depth });
    const agent = saved?.agent ?? current;
    if (saved && (agent.name !== role || agent.tools.some(tool => !current.tools.includes(tool)) ||
        (agent.can_delegate && !current.can_delegate) ||
        agent.delegatable_agents.some(role => !current.delegatable_agents.includes(role)))) throw new Error("Saved loadout is no longer authorized by the current role");
    const savedLimits = saved ? validateLimits(saved.limits) : limits;
    const runLimits = saved ? {
      max_parallel: Math.min(limits.max_parallel, savedLimits.max_parallel),
      max_depth: Math.min(limits.max_depth, savedLimits.max_depth),
      max_children: Math.min(limits.max_children, savedLimits.max_children),
      max_nested_children: Math.min(limits.max_nested_children, savedLimits.max_nested_children),
    } : limits;
    authorize(agent, { manual, depth, canDelegate, delegatableAgents, maxDepth: runLimits.max_depth });
    if (shuttingDown) throw new Error("Subagent dispatcher is shutting down");
    const slash = agent.model.indexOf("/");
    const model = ctx.modelRegistry.find(agent.model.slice(0, slash), agent.model.slice(slash + 1));
    if (!model) {
      throw new Error(`Model not registered: ${agent.model}`);
    }
    if (!getSupportedThinkingLevels(model).includes(agent.thinking)) {
      throw new Error(`Thinking ${agent.thinking} not supported by ${agent.model}`);
    }
    const toolExtensions = resolveTools(agent.tools, pi.getAllTools(), pi.getActiveTools());
    if (saved && (toolExtensions.length !== saved.toolExtensions.length ||
        toolExtensions.some(path => !saved.toolExtensions.includes(path)))) {
      throw new Error("Tool extension sources changed; create a new delegation instead of silently changing the saved loadout");
    }
    if (agent.can_delegate && depth + 1 < runLimits.max_depth &&
        DELEGATION_TOOLS.some(tool => !pi.getActiveTools().includes(tool))) {
      throw new Error("Parent delegation tools are not all active");
    }
    // Resolve existing ancestors too, so aliases through symlinked directories
    // cannot accidentally reserve the same files under different names.
    const canonical = async (path: string): Promise<string> => {
      try { return await realpath(path); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = dirname(path);
        if (parent === path) throw error;
        return join(await canonical(parent), path.slice(parent.length));
      }
    };
    const writePaths = await Promise.all((contract?.scope.write ?? []).map(path =>
      canonical(resolve(saved?.cwd ?? ctx.cwd, path))));
    const overlaps = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep) || b.startsWith(a.endsWith(sep) ? a : a + sep);
    for (const worker of active.values()) {
      const other = worker.info();
      if (writePaths.some(path => (other.writePaths ?? []).some(owned => overlaps(path, owned)))) {
        throw new Error(`Write scope overlaps active worker ${other.name}. Continue independent work; delegate the dependent change after its result.`);
      }
    }
    const name = saved ? requestedName! : workerName(records, role, requestedName);
    const previous = records.get(name);
    const runId = randomUUID();
    records.set(name, { name, role, runId });
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let markDone: () => void;
    let workerControl: WorkerHandle | undefined;
    let acknowledged = false;
    const descendants = new Map<string, any>();
    let info: any = { runId, parentRunId, startedAt: Date.now(), name, role, mode,
      agent: name, model: agent.model, thinking: agent.thinking, contract, parallelWork, writePaths,
      goal: displayText(goal, 128000), status: "running", observation: { state: "unseen", lastEventAt: 0 }, activity: "Starting worker", turns: 0, elapsedMs: 0 };
    active.set(controller, {
      done: new Promise<void>(resolve => { markDone = resolve; }),
      stop: () => workerControl ? workerControl.stop() : controller.abort(),
      interrupt: () => workerControl ? workerControl.interrupt() : controller.abort(),
      resume: (message?: string) => workerControl?.resume(message),
      message: (message: string) => {
        if (!workerControl) throw new Error("Worker is starting; wait for its startup acknowledgement");
        return workerControl.message(message);
      },
      control: request => {
        if (!workerControl) throw new Error("Worker is starting");
        return workerControl.control(request);
      },
      descendants: () => descendants,
      controlError: error => ctx.ui?.notify?.(`Worker control failed: ${error.message}`, "error"),
      info: () => info,
    });
    let lastProgressAt = 0;
    let release: (() => Promise<void>) | undefined;
    function publish(update: any) {
      if (shuttingDown) return;
      const preview = workerPreview(update);
      if (!preview) return;
      const changed = states.update(update);
      if (changed) {
        try { pi.appendEntry("subagent-state", { ...preview,
          contract: update.contract, mode: update.mode, parallelWork: update.parallelWork,
          output: typeof update.output === "string" ? update.output.slice(0, 12000) : undefined, runDir: update.runDir }); } catch {}
      }
      // Relay bounded progress independently of the startup acknowledgement.
      if (depth === 0) {
        if (preview.status === "running" || preview.status === "paused") widget.update(preview);
        else widget.finish(preview);
      } else {
        // The initial tool response is only a startup acknowledgement.
        // All subsequent nested progress uses the private supervisor channel.
        pi.events.emit("subagents:progress", preview);
      }
    }
    function notifyProgress(force = false) {
      if (shuttingDown || acknowledged) return;
      const now = Date.now();
      if (!force && now - lastProgressAt < 200) return;
      lastProgressAt = now;
      onUpdate?.({
        content: [{ type: "text", text: progressLine(info) }],
        details: { ...info, descendants: [...descendants.values()] },
      });
    }
    function markUnfinishedDescendantsCancelled() {
      for (const [id, child] of descendants) {
        if (!["running", "paused"].includes(child.status)) continue;
        const ended = { ...child, status: "cancelled", activity: "Parent worker ended" };
        descendants.set(id, ended);
        publish(ended);
      }
    }
    const finish = async (result: any) => {
      info = { ...info, ...result, activity: result.status === "completed" ? "Finished — not yet verified" : result.status };
      markUnfinishedDescendantsCancelled();
      publish(info);
      try { await release?.(); }
      catch (error) {
        info = { ...info, status: "failed", error: `Slot cleanup failed: ${error.message}` };
        publish(info);
      }
      finally {
        active.delete(controller);
        markDone!();
      }
      if (!shuttingDown && acknowledged) {
        pi.sendMessage({
          customType: "subagent-completion",
          content: resumePrompt(`Worker ${name}: ${info.status}. Completion is not approval.`, [info]),
          display: true,
          details: { runId, name, role, status: info.status, runDir: info.runDir, usage: info.usage },
        }, { triggerTurn: !suspended, deliverAs: suspended ? "nextTurn" : "steer" });
      }
    };
    let background: Promise<void> | undefined;
    try {
      const pool = await getPool();
      const parentLimit = depth === 0 ? runLimits.max_children : runLimits.max_nested_children;
      release = await acquireWorkerSlots(pool, runLimits.max_parallel, parentIdentity, parentLimit, controller.signal);
      controller.signal.throwIfAborted();
      if (!shuttingDown && ctx.mode === "tui" && ctx.hasUI) {
        widget.start(ctx.ui, info);
      }
      publish(info);
      notifyProgress(true);
      workerControl = startWorker({
        agent, task, contract, cwd: saved?.cwd ?? ctx.cwd, depth, extensionPath, toolExtensions, ticketsEnabled,
        originalTask: saved?.task ?? task, resumeSession: saved?.sessionFile,
        runsDir, signal: controller.signal, limits: runLimits, pool, runId, parentRunId, waitForSession: true,
        onPrepared: (prepared: any) => {
          info = { ...info, ...prepared };
          const record = { name, role, runId, runDir: prepared.runDir, cwd: saved?.cwd ?? ctx.cwd, goal };
          records.set(name, record);
          pi.appendEntry("subagent-run", record);
        },
        onProgress: (progress: any) => {
          if (shuttingDown) return;
          info = { ...info, ...progress };
          if (progress.status && !["paused", "running"].includes(progress.status)) {
            markUnfinishedDescendantsCancelled();
          }
          publish(info);
          notifyProgress();
        },
        onDescendant: (raw: any) => {
          const preview = workerPreview(raw);
          if (!preview || preview.runId === runId ||
              (preview.parentRunId !== runId && !descendants.has(preview.parentRunId))) return;
          const previous = descendants.get(preview.runId);
          if (previous && previous.parentRunId !== preview.parentRunId) return;
          // Bound UI history independently of worker stdout limits.
          if (!descendants.has(preview.runId) && descendants.size >= 256) return;
          descendants.set(preview.runId, preview);
          publish(preview);
          notifyProgress(preview.status !== "running");
        },
      });
      background = workerControl.done.then(finish, error => finish({
        ...info, status: controller.signal.aborted ? "cancelled" : "failed",
        error: String(error.message), output: "", elapsedMs: Date.now() - info.startedAt,
      }));
      background.catch(() => {}); // Shutdown waits on the owned completion handle.
      await workerControl.ready;
      controller.signal.throwIfAborted();
      if (mode === "sync") {
        // Pauses retain the existing worker and do not resolve this promise.
        await background;
        return {
          content: [{ type: "text", text: resumePrompt(
            `Worker ${name}: ${info.status}. Completion is not approval.`, [info]) }],
          details: { ...info, descendants: [...descendants.values()] },
          usage: info.usage,
          isError: info.status !== "completed",
        };
      }
      acknowledged = true;
      return {
        content: [{ type: "text", text: `Started ${name} (${role}). Results arrive separately. Do only the declared independent work; do not repeat this worker’s scope or begin dependent work. Do not poll or wait in a tool.\nRun: ${runId}\nArtifacts: ${info.runDir}` }],
        details: { ...info, output: undefined, descendants: [...descendants.values()] },
      };
    } catch (error) {
      workerControl?.stop();
      if (background) await background.catch(() => {});
      else await finish({ ...info, status: controller.signal.aborted ? "cancelled" : "failed",
        error: String(error.message), output: "" });
      if (previous) records.set(name, previous);
      else records.delete(name);
      try { pi.appendEntry("subagent-run", previous ?? { name, deleted: true }); } catch {}
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async function messageWorker(name: string, message: string, ctx: any, signal?: AbortSignal, manual = false) {
    if (!message.trim() || message.length > 16000) throw new Error("Message must contain 1–16000 characters");
    signal?.throwIfAborted();
    if (shuttingDown) throw new Error("Dispatcher is shutting down");
    const record = records.get(name);
    if (!record) throw new Error(`Unknown worker: ${name}. Known names: ${[...records.keys()].join(", ") || "(none)"}`);
    const current = (await discover()).find(agent => agent.name === record.role);
    if (!current) throw new Error(`Worker role no longer exists: ${record.role}`);
    authorize(current, { manual, depth, canDelegate, delegatableAgents, maxDepth: limits.max_depth });
    const live = [...active.values()].find(worker => worker.info().runId === record.runId);
    if (live) {
      if (live.info().status === "paused") await live.resume(message);
      else await live.message(message);
      return { content: [{ type: "text", text: `Message sent to ${name}; completion will arrive separately.` }],
        details: { name, runId: record.runId, status: live.info().status } };
    }
    if (restoring.has(name)) throw new Error(`${name} is already being restored`);
    restoring.add(name);
    try {
      const saved = await readLoadout(record.runDir, runsDir);
      const task = saved.task + "\n\nContinuation request (original contract and restrictions still apply):\n" + message;
      return await invoke({ role: record.role, task, manual, ctx, signal, goal: record.goal, name, saved, mode: "async" });
    } finally { restoring.delete(name); }
  }

  async function controlWorker(runId: string, action: string, prompt: string | undefined, ctx: any) {
    if (shuttingDown) throw new Error("Dispatcher is shutting down");
    if (!["pause", "resume", "message"].includes(action)) throw new Error("Unknown worker action");
    if (action === "message" && (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16000)) {
      throw new Error("Message must contain 1–16000 characters");
    }
    const live = [...active.values()].find(worker => worker.info().runId === runId);
    if (live) {
      if (action === "pause") await live.interrupt();
      else if (action === "resume") {
        if (live.info().status !== "paused") throw new Error("Worker is not paused");
        suspended = false;
        await live.resume();
      } else {
        suspended = false;
        if (live.info().status === "paused") await live.resume(prompt);
        else await live.message(prompt!);
      }
      return { runId };
    }
    const owner = [...active.values()].find(worker => worker.descendants().has(runId));
    if (owner) return owner.control({ runId, action, prompt });
    const record = [...records.values()].find(record => record.runId === runId);
    if (!record) throw new Error("This worker is no longer controlled by this session");
    if (action === "pause") throw new Error("Worker is not running");
    suspended = false;
    const result = await messageWorker(record.name, prompt || "Continue the original delegated task.", ctx, undefined, true);
    return { runId: result.details.runId };
  }

  async function waitForWorkers(ctx) {
    // Retain the parent through both children and completion-triggered turns.
    while (!shuttingDown && (active.size > 0 || !ctx.isIdle())) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  async function shutdown() {
    shuttingDown = true;
    const workers = [...active.values()];
    for (const worker of workers) worker.stop();
    await Promise.allSettled(workers.map(worker => worker.done));
  }

  return {
    depth, canDelegate, limits, delegatableAgents,
    start: invoke, message: messageWorker, controlWorker, discover, restoreSession, listWorkers,
    readLog: row => readLog(listWorkers().find(item => item.runId === row.runId)?.runDir),
    interruptAll, resumePaused, waitForWorkers, shutdown,
    agentStarted() { suspended = false; },
    get names() { return [...records.keys()]; },
    get hasWorkers() { return active.size > 0; },
    get ownsSessions() { return active.size > 0 || restoring.size > 0; },
    get hasPausedWorkers() { return [...active.values()].some(worker => worker.info().status === "paused"); },
  };
}
