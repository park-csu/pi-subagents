import { writeSync } from "node:fs";

// Invoked as a slash command in the real CLI: no provider/model request.
export default function (pi) {
  // PI_OFFLINE only disables catalog networking, not inference. Fail closed
  // before any provider request even if command/input routing regresses.
  pi.on("before_provider_request", () => process.exit(2));
  pi.on("input", async (event, ctx) => {
      if (event.text !== "/offline-pane-test") return { action: "continue" };
      if (ctx.mode !== "tui" || !ctx.hasUI || !process.stdin.isTTY || !process.stdout.isTTY) {
        process.exit(2);
      }
      pi.sendMessage({ customType: "terminal-smoke", content: "PI_TUI_OFFLINE_MARKER", display: true });
      // Keep the actual TUI visible long enough for the isolated test to capture.
      await new Promise(resolve => setTimeout(resolve, 1200));
      writeSync(3, JSON.stringify({ type: "message_end", message: {
        role: "assistant", stopReason: "stop", content: [{ type: "text", text: "offline actual Pi completed" }],
      } }) + "\n");
      writeSync(3, JSON.stringify({ type: "worker_task_done", report: "offline actual Pi completed" }) + "\n");
      ctx.shutdown();
      return { action: "handled" };
  });
}
