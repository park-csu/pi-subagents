// A->B->A resizes can leave tmux's viewport reflowed even though Node's final
// columns/rows equal the previous frame. A normal differential render cannot
// repair that. Reset on SIGWINCH itself, not only stdout's size-change event.
export function terminalResizeWidget(tui, signals = process) {
  let pending;
  const resize = () => {
    if (pending) return;
    // Run after Node refreshes stdout dimensions and coalesce this event burst.
    pending = setImmediate(() => {
      pending = undefined;
      tui.requestRender(true);
    });
  };
  signals.on("SIGWINCH", resize);
  return {
    render: () => [],
    invalidate() {},
    dispose() {
      signals.removeListener("SIGWINCH", resize);
      clearImmediate(pending);
      pending = undefined;
    },
  };
}

export function installTmuxRedraw(pi) {
  let widget;
  pi.on("session_start", (_event, ctx) => {
    widget?.dispose();
    widget = undefined;
    if (!process.env.TMUX || ctx.mode !== "tui" || !ctx.hasUI) return;
    ctx.ui.setWidget("subagents-terminal-resize", tui => {
      widget = terminalResizeWidget(tui);
      return widget;
    });
  });
  pi.on("session_shutdown", () => {
    widget?.dispose();
    widget = undefined;
  });
}
