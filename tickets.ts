import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "subagents-tickets";

// This controls documentation policy only, never tool permissions.
export function installTickets(pi: ExtensionAPI, depth: number) {
  const inherited = depth > 0 && process.env.PI_SUBAGENT_TICKETS === "on";
  let selected = inherited;
  let active = selected;

  const restore = (_event: unknown, ctx: ExtensionContext) => {
    selected = inherited;
    if (depth === 0) {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
        const data = entry.data as { enabled?: unknown } | undefined;
        if (typeof data?.enabled === "boolean") selected = data.enabled;
      }
    }
    if (ctx.isIdle()) active = selected;
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);

  if (depth === 0) {
    pi.registerCommand("tickets", {
      description: "Show ticket workflow mode, or set /tickets on|off (session-local; default off)",
      getArgumentCompletions: prefix => ["on", "off"]
        .filter(value => value.startsWith(prefix))
        .map(value => ({ value, label: value })),
      handler: async (args, ctx) => {
        const value = args.trim();
        if (value && value !== "on" && value !== "off") {
          ctx.ui.notify("Usage: /tickets [on|off]", "warning");
          return;
        }
        if (value) {
          const enabled = value === "on";
          if (enabled !== selected) {
            pi.appendEntry(ENTRY_TYPE, { enabled });
            selected = enabled;
          }
        }
        ctx.ui.notify(`Tickets: ${selected ? "on" : "off"}. `
          + (ctx.isIdle() ? "Applies to the next agent run or worker launch."
            : `Applies to the next agent run; current run remains ${active ? "on" : "off"}.`)
          + " Existing ticket files and live workers are unchanged.", "info");
      },
    });
  }

  return {
    get active() { return active; },
    beginRun() {
      active = selected;
      return active;
    },
    forDispatch(ctx: Pick<ExtensionContext, "isIdle">) {
      return ctx.isIdle() ? selected : active;
    },
  };
}
