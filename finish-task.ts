import { createToolRegistrar } from "ui-kit/tools";
import { Type } from "typebox";

/** Lifecycle tool, installed only in supervised worker sessions. */
export function installFinishTask(pi, hasChildren: () => boolean) {
  const registerTool = createToolRegistrar(pi);
  let assistantToolCalls = 0;
  let finished = false;
  pi.on("tool_execution_end", event => {
    if (event.toolName === "finish_task" && !event.isError && !event.result?.isError &&
        typeof event.result?.details?.finishTask?.report === "string") finished = true;
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message?.role === "assistant") {
      assistantToolCalls = (event.message.content ?? []).filter(part => part.type === "toolCall").length;
      if (!finished && event.message.stopReason === "stop" && assistantToolCalls === 0 &&
          !ctx.signal?.aborted && !hasChildren()) {
        pi.sendMessage({
          customType: "finish-task-reminder",
          content: "Your delegated job has not been handed off yet. If the work is complete, call finish_task alone with your final report, evidence, and unresolved limitations. If work remains, continue within the original task and constraints. Ordinary final prose does not complete the delegation.",
          display: false,
        }, { triggerTurn: true, deliverAs: "followUp" });
      }
    }
  });
  registerTool({
    name: "finish_task",
    label: "Finish task",
    description: "Hand your final report to the parent and end this delegated job. Call alone, after all work and owned children settle. Include findings, changed files, checks and unresolved limitations. This declares readiness for parent review, not approval. Ordinary final prose does not complete the job.",
    parameters: Type.Object({
      report: Type.String({ minLength: 1, maxLength: 12000,
        description: "Final handoff report, including evidence and remaining limitations." }),
    }, { additionalProperties: false }),
    execute: async (_id, { report }) => {
      if (typeof report !== "string" || !report.trim() || report.length > 12000) {
        throw new Error("report must contain 1–12000 characters");
      }
      if (assistantToolCalls > 1) throw new Error("Call finish_task alone, not alongside other tools");
      if (hasChildren()) throw new Error("Owned workers must settle before finish_task");
      return {
        content: [{ type: "text", text: "Report handed to parent for review. Completion is not approval." }],
        details: { finishTask: { report } },
        terminate: true,
      };
    },
  });
}
