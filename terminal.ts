import { readFileSync, writeSync } from "node:fs";
import { Socket } from "node:net";
import { workerPreview } from "./activity.ts";

// Interactive stdout belongs entirely to Pi's own TUI. FD 3 carries the same
// bounded/delta-oriented events that runChild consumes in JSON mode.
export function installTerminalBridge(pi, env = process.env, resumeChildren = () => {}, interruptChildren = () => {},
    hasChildren = () => false, controlWorker = async () => { throw new Error("Worker control unavailable"); }) {
  const terminal = env.PI_SUBAGENT_TUI === "1";
  const rpc = env.PI_SUBAGENT_RPC === "1";
  const persistent = terminal || rpc;
  if (!terminal && !(Number(env.PI_SUBAGENT_DEPTH) > 0)) return;
  let context;
  let lastStop;
  let started = false;
  let interrupted = false;
  let explicitInterrupt = false;
  let compacting = false;
  let continueAfterCompaction = false;
  let continuationTimer;
  let taskFinished = false;
  const pauseWaiters = new Set<() => void>();
  let pausePending = Promise.resolve();
  let resumeTimer;
  const deferredPrompts: string[] = [];
  function deliverDeferred() {
    clearTimeout(resumeTimer);
    if (explicitInterrupt || interrupted || !context) return;
    if (!context.isIdle()) {
      resumeTimer = setTimeout(deliverDeferred, 20);
      return;
    }
    const prompt = deferredPrompts.splice(0).join("\n\n");
    if (prompt) {
      try { pi.sendUserMessage(prompt, { deliverAs: "steer" }); }
      catch (error) {
        deferredPrompts.unshift(prompt);
        explicitInterrupt = true;
        reportPaused();
        send({ type: "worker_resume_failed", error: String(error.message).slice(0, 400) });
      }
    }
  }
  const send = event => {
    let wire = event;
    if (event.type === "message_update") {
      const { partial, ...delta } = event.assistantMessageEvent;
      wire = { type: event.type, usage: event.message?.usage, assistantMessageEvent: delta };
    }
    const bytes = Buffer.from(JSON.stringify(wire) + "\n");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(3, bytes, offset, bytes.length - offset);
  };
  const reportPaused = () => {
    interrupted = true;
    send({ type: "worker_paused" });
    for (const resolve of pauseWaiters) resolve();
    pauseWaiters.clear();
  };
  const unsubscribeProgress = pi.events?.on("subagents:progress", info => {
    const preview = workerPreview(info);
    if (preview) send({ type: "worker_progress", info: preview });
  });
  const unsubscribeResuming = pi.events?.on("subagents:resuming", () => {
    interrupted = false;
    explicitInterrupt = false;
    send({ type: "worker_resumed" });
  });
  const unsubscribePaused = pi.events?.on("subagents:paused", reportPaused);
  const unsubscribeInterrupt = pi.events?.on("subagents:user-interrupt", () => { explicitInterrupt = true; });
  pi.on("session_before_compact", event => {
    compacting = true;
    continueAfterCompaction = started && !explicitInterrupt &&
      (interrupted || lastStop === "aborted" || lastStop === "toolUse");
    if (!explicitInterrupt) interrupted = false;
    send({ type: "worker_compaction", phase: "started", reason: event.reason,
      userInterrupted: explicitInterrupt });
  });
  pi.on("session_compact", event => {
    compacting = false;
    send({ type: "worker_compaction", phase: "completed", reason: event.reason,
      userInterrupted: explicitInterrupt, usage: event.compactionEntry?.usage });
    if (explicitInterrupt) return;
    interrupted = false;
    lastStop = undefined;
    // Native threshold/overflow compaction already resumes the agent. Only
    // manual compaction of active work needs continuation, after Pi clears its
    // compaction lock. Never restart work explicitly paused by the user.
    if (persistent && event.reason === "manual" && continueAfterCompaction) {
      continuationTimer = setTimeout(() => {
        if (explicitInterrupt || interrupted || !context?.isIdle()) return;
        send({ type: "worker_resumed" });
        pi.sendUserMessage("Continue the interrupted task after compaction. Preserve the original constraints.");
      }, 0);
    }
    continueAfterCompaction = false;
  });
  pi.on("session_compact_failed", event => {
    compacting = false;
    continueAfterCompaction = false;
    reportPaused();
    send({ type: "worker_compaction", phase: "failed", reason: event.reason,
      userInterrupted: explicitInterrupt, aborted: event.aborted,
      error: String(event.errorMessage ?? "").slice(0, 400) });
  });
  function resume(prompt) {
    if (!context) return;
    interrupted = false;
    explicitInterrupt = false;
    send({ type: "worker_resumed" });
    try {
      resumeChildren();
      if (rpc && (!context.isIdle() || deferredPrompts.length)) {
        // A cancelled sync delegate is still unwinding until its child ends.
        // Steering that aborted turn would never start a fresh parent turn.
        deferredPrompts.push(prompt);
        deliverDeferred();
      } else pi.sendUserMessage(prompt, { deliverAs: "steer" });
    } catch (error) {
      interrupted = true;
      explicitInterrupt = true;
      interruptChildren();
      if (context.isIdle()) reportPaused();
      else context.abort();
      throw error;
    }
  }
  function handleControlRequest(request) {
    if (request === "interrupt") {
      interrupted = true;
      explicitInterrupt = true;
      interruptChildren();
      if (context?.isIdle()) reportPaused();
      else context?.abort();
      return;
    }
    try {
      const message = JSON.parse(request);
      if (typeof message.prompt !== "string" || !message.prompt.trim() || message.prompt.length > 16000) return;
      if (message.type === "resume") resume(message.prompt);
      else if (message.type === "message") pi.sendUserMessage(message.prompt, { deliverAs: "steer" });
    } catch { /* Ignore malformed supervisor command. */ }
  }

  // RPC prompt commands are handled by Pi before model input, even during a turn.
  // Keeping lifecycle coordination here also propagates interrupts to owned children.
  if (rpc) pi.registerCommand("worker-control", {
    description: "Supervisor control for this worker session",
    handler: async (args, ctx) => {
      const request = JSON.parse(args);
      try {
        let data;
        if (taskFinished) throw new Error("Worker has already handed off its report");
        if (request.type === "control") data = await controlWorker(request.runId, request.action, request.prompt, ctx);
        else if (request.type === "interrupt") {
          interrupted = true;
          explicitInterrupt = true;
          const paused = context?.isIdle() ? Promise.resolve() : new Promise<void>(resolve => pauseWaiters.add(resolve));
          const children = interruptChildren();
          if (context?.isIdle()) reportPaused(); else context?.abort();
          // A sync delegate remains pending until its child completes. Waiting
          // for this parent's agent_settled would deadlock pause/resume. Its
          // turn is aborted; acknowledge once owned children have paused.
          const ownsChildren = hasChildren();
          pausePending = (async () => {
            if (ownsChildren) { await children; reportPaused(); }
            await Promise.all([paused, children]);
          })();
          await pausePending;
        }
        else {
          if (!["resume", "message"].includes(request.type) || typeof request.prompt !== "string" ||
              !request.prompt.trim() || request.prompt.length > 16000) throw new Error("Invalid worker control");
          if (request.type === "resume") { await pausePending; resume(request.prompt); }
          else if (deferredPrompts.length) deferredPrompts.push(request.prompt);
          else pi.sendUserMessage(request.prompt, { deliverAs: "steer" });
        }
        send({ type: "worker_control_result", id: request.id, success: true, data });
      } catch (error) { send({ type: "worker_control_result", id: request.id, success: false, error: error.message }); }
    },
  });

  // A separate supervisor channel requests the same abort as native Pi Esc.
  // No OS signal suspension: the current turn stops, the session stays alive.
  const control = new Socket({ fd: 4, readable: true, writable: false });
  control.setEncoding("utf8");
  let buffer = "";
  control.on("data", chunk => {
    buffer += chunk.toString();
    if (buffer.length > 64000) process.exit(2);
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const request = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      handleControlRequest(request);
    }
  });
  control.on("error", () => process.exit(2));
  control.on("end", () => process.exit(2));
  for (const type of ["agent_start", "agent_end", "turn_start", "turn_end",
    "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end"]) {
    pi.on(type, event => {
      try { if (terminal) send(event); }
      catch { process.exit(2); } // Lost supervisor/event pipe: never run unsupervised.
    });
  }
  pi.on("message_end", event => {
    if (event.message?.role === "assistant") lastStop = event.message.stopReason;
  });
  pi.on("tool_execution_end", event => {
    if (event.toolName !== "finish_task" || event.isError || event.result?.isError) return;
    const report = event.result?.details?.finishTask?.report;
    if (typeof report !== "string" || !report.trim() || report.length > 12000 || taskFinished) return;
    taskFinished = true;
    send({ type: "worker_task_done", report });
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (taskFinished && !hasChildren()) ctx.shutdown();
  });
  pi.on("agent_start", () => {
    if (!started) send({ type: "worker_ready" });
    started = true;
    if (interrupted) send({ type: "worker_resumed" });
    interrupted = false;
    explicitInterrupt = false;
    lastStop = undefined;
  });
  pi.on("agent_end", (_event, ctx) => {
    if (ctx.signal?.aborted && !compacting && !deferredPrompts.length) interrupted = true;
  });
  pi.on("session_start", (_event, ctx) => {
    if (terminal && ctx.mode !== "tui") process.exit(2);
    context = ctx;
    if (!terminal) return; // The headless JSON/RPC transport owns its initial prompt.
    const task = readFileSync(env.PI_SUBAGENT_HANDOFF, "utf8");
    // Let InteractiveMode finish initialising before delivering the work.
    setTimeout(() => {
      if (interrupted) {
        ctx.ui.setEditorText(task);
        reportPaused();
      } else pi.sendUserMessage(task);
    }, 0);
  });
  if (persistent) {
    pi.on("agent_settled", (_event, ctx) => {
      if (taskFinished) return;
      if (compacting && !explicitInterrupt) return;
      if (deferredPrompts.length && !explicitInterrupt) {
        interrupted = false;
        clearTimeout(resumeTimer);
        resumeTimer = setTimeout(deliverDeferred, 0);
        return;
      }
      const unfinished = interrupted || ctx.signal?.aborted || lastStop === "aborted" || lastStop === "toolUse";
      if (unfinished) reportPaused();
      else if (started && !hasChildren()) ctx.shutdown();
    });
  }
  // A worker is one task/session. Continue it in place rather than replacing it
  // with a session whose accounting/contract is no longer owned by the parent.
  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));
  pi.on("session_shutdown", () => {
    interrupted = true;
    clearTimeout(continuationTimer);
    clearTimeout(resumeTimer);
    control.destroy();
    unsubscribeProgress?.();
    unsubscribeResuming?.();
    unsubscribePaused?.();
    unsubscribeInterrupt?.();
  });
}
