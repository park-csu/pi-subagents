import { createToolRegistrar, getToolRenderers } from "ui-kit/tools";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { installFinishTask } from "./finish-task.ts";
import { truncateToWidth, matchesKey, wrapTextWithAnsi, visibleWidth, Input } from "@earendil-works/pi-tui";
import { WorkerWidget } from "./activity.ts";
import { createDispatcher } from "./dispatcher.ts";
import { installTerminalBridge } from "./terminal.ts";
import { installTmuxRedraw } from "./tmux-redraw.ts";
import { renderDelegateCall, renderDelegateMessageCall, renderDelegateResult, renderSubagentCompletion } from "./render.ts";
import { createTranscriptRenderer } from "./transcript.ts";
import { createWorkerBrowser } from "./browser.ts";
import { WorkerStates } from "./state.ts";
import { installUiPanels } from "./ui-kit.ts";
import { workflowContext } from "./workflow.ts";
import { installTickets } from "./tickets.ts";

import { validateContract, contractMarkdown } from "./contract.ts";

const contractText = () => Type.String({ minLength: 1, pattern: "\\S" });
const contractList = (required = false) => Type.Array(contractText(), { minItems: required ? 1 : 0, maxItems: 64 });
const contractSchema = Type.Object({
  objective: contractText(),
  scope: Type.Object({ read: contractList(), write: contractList() }, { additionalProperties: false,
    description: "Read references and literal owned write paths (files/directories relative to cwd). Empty write means read-only. Parallel workers must have disjoint write scopes." }),
  plan: contractList(true),
  acceptance: contractList(true),
  context: Type.Optional(contractText()),
  constraints: Type.Optional(contractList()),
}, { additionalProperties: false });

const extensionPath = fileURLToPath(import.meta.url);

export default function (pi: ExtensionAPI) {
  const registerTool = createToolRegistrar(pi);
  installTmuxRedraw(pi);
  pi.registerMessageRenderer("subagent-completion", renderSubagentCompletion);

  const states = new WorkerStates();
  const widget = new WorkerWidget({ truncate: truncateToWidth });
  const uiPanels = installUiPanels(pi, widget);
  const tickets = installTickets(pi, Number(process.env.PI_SUBAGENT_DEPTH ?? 0));
  const dispatcher = createDispatcher(pi, { extensionPath, states, widget,
    getTicketsEnabled: ctx => tickets.forDispatch(ctx) });
  const { depth, canDelegate, limits, delegatableAgents } = dispatcher;
  const childLimit = depth === 0 ? limits.max_children : limits.max_nested_children;
  let browserOpen = false;
  let closeBrowser: (() => void) | undefined;
  let detachInput: (() => void) | undefined;

  // Applies to every worker, including leaves with no delegation tools.
  // Append only this session's duties; never forward primary-agent policy to children.
  pi.on("before_agent_start", event => ({
    systemPrompt: event.systemPrompt + "\n\n" + workflowContext(depth, tickets.beginRun()),
  }));

  pi.on("agent_start", () => dispatcher.agentStarted());
  pi.on("session_start", async (_event, ctx) => {
    uiPanels.start(ctx);
    await dispatcher.restoreSession(ctx);
    if (ctx.mode === "tui" && ctx.hasUI) {
      detachInput = ctx.ui.onTerminalInput?.(data => {
        if (!browserOpen && matchesKey(data, "escape")) dispatcher.interruptAll();
        return undefined; // Pi still handles its own Escape key.
      });
    }
  });
  pi.on("input", event => {
    if (event.source !== "interactive" || !/^(continue|resume|계속|재개)[.!]?$/i.test(event.text.trim()) ||
        !dispatcher.hasPausedWorkers) return { action: "continue" };
    pi.events.emit("subagents:resuming", {});
    dispatcher.resumePaused();
    return { action: "continue" };
  });

  if (depth > 0) {
    installFinishTask(pi, () => dispatcher.hasWorkers);
    // Fail before spending tokens if CLI model/thinking resolution changed the contract.
    pi.on("before_provider_request", (_event, ctx) => {
      if (`${ctx.model?.provider}/${ctx.model?.id}` !== process.env.PI_SUBAGENT_MODEL ||
          ctx.thinkingLevel !== process.env.PI_SUBAGENT_THINKING) {
        // Pi catches event-handler exceptions and continues. Exit this child
        // instead so no provider request is made with a clamped configuration.
        process.stderr.write("Subagent model/thinking mismatch; fallback is forbidden\n");
        process.exit(2);
      }
      const expected = JSON.parse(process.env.PI_SUBAGENT_TOOLS || "[]");
      const actual = pi.getActiveTools();
      if (expected.length !== actual.length || expected.some((name: string) => !actual.includes(name))) {
        process.stderr.write("Subagent tool allowlist mismatch\n");
        process.exit(2);
      }
    });
    pi.on("tool_call", (event) => {
      const expected = JSON.parse(process.env.PI_SUBAGENT_TOOLS || "[]");
      if (!expected.includes(event.toolName)) return { block: true, reason: "Tool outside subagent allowlist", terminate: true };
    });
  }

  if (canDelegate && depth < limits.max_depth) {
    registerTool({
      name: "delegate",
      label: "Delegate",
      description: `Delegate in the CURRENT working directory. mode=sync (default) waits for finish_task and worker cleanup, returning the report directly; failures/cancellation also return. mode=async requires parallel_work naming the parent’s independent work and returns startup acknowledgement; completion arrives separately. Interrupt pauses do not complete a sync call. Do not poll or wait through other tools. Optional name stays addressable by delegate_message. This parent may own at most ${childLimit} active direct children; shared tree limit ${limits.max_parallel} workers, depth ${limits.max_depth}; no queue. Paused workers retain slots. Completed is not approval. No sandbox/worktree: parallel writes must be disjoint.`,
      parameters: Type.Object({ agent: Type.String(), name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        mode: Type.Optional(StringEnum(["sync", "async"], { description: "sync (default): wait for the report before dependent work; async: overlap only with independent work described in parallel_work." })),
        parallel_work: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Required for async: concrete independent work the parent will do, or independent sibling tasks to launch. Do not duplicate the delegated scope or start dependent implementation." })),
        task: contractSchema }, { additionalProperties: false }),
      execute: async (_id, params, signal, onUpdate, ctx) => {
        const contract = validateContract(params.task);
        return dispatcher.start({
          role: params.agent, task: contractMarkdown(contract), contract,
          ctx, signal, onUpdate, goal: contract.objective, name: params.name,
          mode: params.mode, parallelWork: params.parallel_work,
        });
      },
      renderCall: renderDelegateCall,
      renderResult: (result, options, theme, context) =>
        renderDelegateResult(result, options, theme, context, states),
    });
    registerTool({
      name: "delegate_message", label: "Message worker",
      description: "Send an authorized correction or continuation to an owned worker by name. Running workers receive a steer; paused workers resume; ended workers restart their saved session with the original loadout, subject to current permissions. Returns immediately. Use only within user authorization, not for routine agent chatter or to bypass resource limits.",
      parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }),
        message: Type.String({ minLength: 1, maxLength: 16000 }) }, { additionalProperties: false }),
      execute: (_id, params, signal, _onUpdate, ctx) => dispatcher.message(params.name, params.message, ctx, signal),
      renderCall: renderDelegateMessageCall,
    });
    pi.on("before_agent_start", async (event) => {
      const agents = (await dispatcher.discover()).filter(agent =>
        agent.callable && (delegatableAgents === undefined || delegatableAgents.includes(agent.name)));
      return { systemPrompt: event.systemPrompt +
        "\n\nCallable subagents:\n" +
        "Handle tiny tasks, known-path reads, and simple lookups directly. Delegate only when isolated investigation or useful parallel work outweighs startup and handoff cost; no file-count quota requires delegation.\n" +
        (tickets.active
          ? "For ticketed work, give the absolute ticket folder, current assignment and ledger writer; keep the objective, owned paths, constraints, protected tests and checks, and essential evidence/document references in task.md rather than copying them into every call. For unticketed discovery, give the objective, scope and required evidence. Reuse the same ticket for authorized corrections.\n"
          : "Fill task.objective, scope.read/write, numbered plan and acceptance in the JSON contract; include constraints, protected tests and checks, and required evidence. No ticket bookkeeping is required.\n") +
        "Do not forward the full conversation or repeated standing rules. Keep parallel writes disjoint, including tests and configuration. Reuse named workers for authorized corrections.\n" +
        "Use mode=sync by default when the next action depends on the report or no useful independent work exists. Choose mode=async only with parallel_work naming concrete independent work; dispatching a worker is not permission to repeat its investigation or edit its owned files. Wait for the result before dependent implementation, testing or integration. After async dispatch, do independent work or end the turn; the session stays open for child results. Nested agents cannot gain work tools unavailable to their parent; finish_task is a worker-only lifecycle tool. At capacity, work directly or return a blocker; never bypass limits through bash.\n" +
        agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n") };
    });
  }

  if (depth === 0) {
    pi.registerCommand("subagents", {
      description: "Browse worker status, activity and reports; /subagents roles lists definitions",
      handler: async (args, ctx) => {
        if (args.trim() === "roles") {
          ctx.ui.notify(`Limits: ${limits.max_children} direct children · ${limits.max_parallel} workers · depth ${limits.max_depth}\n` +
            (await dispatcher.discover()).map(a => `${a.name}: ${a.model} ${a.thinking}; callable=${a.callable}, delegatable_agents=[${a.delegatable_agents.join(", ")}]`).join("\n"), "info");
          return;
        }
        if (args.trim()) { ctx.ui.notify("Usage: /subagents [roles]", "warning"); return; }
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify(dispatcher.listWorkers().map(row => `${row.agent}: ${row.status}`).join("\n") || "No worker sessions yet.", "info");
          return;
        }
        if (browserOpen) return;
        browserOpen = true;
        let view;
        try {
          await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
            view = createWorkerBrowser({ list: dispatcher.listWorkers, readLog: dispatcher.readLog,
              tui, theme, done, matchesKey, keybindings, truncate: truncateToWidth, wrap: wrapTextWithAnsi, measure: visibleWidth,
              control: (runId, action, message) => dispatcher.controlWorker(runId, action, message, ctx),
              input: new Input({ prompt: "> " }),
              transcript: createTranscriptRenderer(tui, ctx.cwd, () => getToolRenderers(pi.events)) });
            closeBrowser = () => { view.dispose(); done(); };
            return view;
          }, { overlay: true, overlayOptions: { width: 120, maxHeight: "90%", margin: 1 } });
        } finally {
          view?.dispose();
          closeBrowser = undefined;
          browserOpen = false;
        }
      },
    });
    pi.registerCommand("subagent-message", {
      description: "Steer/resume an owned worker: /subagent-message NAME MESSAGE",
      handler: async (args, ctx) => {
        const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
        if (!match) { ctx.ui.notify("Usage: /subagent-message NAME MESSAGE", "warning"); return; }
        const result = await dispatcher.message(match[1], match[2], ctx, undefined, true);
        ctx.ui.notify(result.content[0].text, "info");
      },
    });
    pi.registerCommand("subagent", {
      description: "Run a subagent: /subagent [--sync|--async] ROLE TASK (default sync)",
      handler: async (args, ctx) => {
        const match = args.trim().match(/^(?:(--sync|--async)\s+)?([^\s-][^\s]*)\s+([\s\S]+)$/);
        if (!match) { ctx.ui.notify("Usage: /subagent [--sync|--async] ROLE TASK", "warning"); return; }
        await ctx.waitForIdle();
        const result = await dispatcher.start({
          role: match[2],
          task: match[3],
          mode: match[1] === "--async" ? "async" : "sync",
          manual: true,
          ctx,
          goal: match[3],
        });
        pi.sendMessage({ customType: "subagent-result", content: result.content, display: true, details: result.details });
      },
    });
  }
  installTerminalBridge(pi, process.env, dispatcher.resumePaused, dispatcher.interruptAll,
    () => dispatcher.hasWorkers, dispatcher.controlWorker);
  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "print" && ctx.mode !== "json") return;
    await dispatcher.waitForWorkers(ctx);
  });
  for (const event of ["session_before_switch", "session_before_fork"] as const) {
    pi.on(event, (_event, ctx) => {
      if (!dispatcher.ownsSessions) return;
      ctx.ui.notify("Wait for or terminate owned workers before replacing this parent session.", "warning");
      return { cancel: true };
    });
  }
  pi.on("session_shutdown", async () => {
    closeBrowser?.();
    const stopped = dispatcher.shutdown();
    detachInput?.();
    uiPanels.stop();
    await stopped;
  });
}
