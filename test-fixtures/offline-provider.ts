// Actual Pi engine fixture. No provider network access, even on fallback.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export default function (pi) {
  globalThis.fetch = async () => { throw new Error("Network disabled in offline worker fixture"); };
  pi.on("before_provider_request", (_event, ctx) => {
    if (ctx.model?.provider !== "offline-worker") process.exit(99);
  });
  pi.registerTool({
    name: "offline_marker", label: "Offline marker", description: "Offline fixture only",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "offline" }] }),
  });
  pi.registerProvider("offline-worker", {
    baseUrl: "http://127.0.0.1:1", apiKey: "offline", api: "offline-worker-api",
    models: [{ id: "fixture", name: "Offline", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple: (model, context) => {
      const stream = createAssistantMessageEventStream();
      const history = JSON.stringify(context.messages);
      const leaf = Number(process.env.PI_SUBAGENT_DEPTH) > Number(process.env.OFFLINE_FIXTURE_PARENT_DEPTH ?? 1);
      const output = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: "stop", content: [],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      setTimeout(() => {
        stream.push({ type: "start", partial: output });
        if (!leaf && !history.includes("offline-child-call") && !history.includes("PARENT_NATIVE_DONE")) {
          output.stopReason = "toolUse";
          const toolCall = { type: "toolCall", id: "offline-child-call", name: "delegate", arguments: {
            agent: "researcher", name: "leaf", task: { objective: "Native child", scope: { read: [], write: [] }, plan: ["Produce offline fixture result"], acceptance: ["Return the completed worker evidence"] },
            parallel_work: "Produce the independent parent waiting marker",
            mode: process.env.OFFLINE_FIXTURE_MODE ?? "async",
          } };
          output.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
        } else {
          const text = history.includes("PARENT_NATIVE_DONE") ? "RESTORED_NATIVE_OK" : leaf ? "LEAF_NATIVE_OK"
            : history.includes("LEAF_NATIVE_OK") ? "PARENT_NATIVE_DONE" : "PARENT_WAITING";
          if (Number(process.env.PI_SUBAGENT_DEPTH) > 0 && text !== "PARENT_WAITING" &&
              (!process.env.OFFLINE_FIXTURE_REMINDER || history.includes("Your delegated job has not been handed off yet."))) {
            output.stopReason = "toolUse";
            const toolCall = { type: "toolCall", id: `offline-finish-${context.messages.length}`,
              name: "finish_task", arguments: { report: text } };
            output.content.push(toolCall);
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
          } else {
            output.content.push({ type: "text", text });
            stream.push({ type: "text_start", contentIndex: 0, partial: output });
            stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
            stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
          }
        }
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      }, leaf ? 1000 : 5);
      return stream;
    },
  });
}
