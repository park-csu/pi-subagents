import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export default function (pi) {
  globalThis.fetch = async () => { throw new Error("Network disabled in RPC fixture"); };
  pi.on("before_provider_request", (_event, ctx) => {
    if (ctx.model?.provider !== "rpc-fixture") process.exit(99);
  });
  pi.registerTool({
    name: "hold_worker", label: "Hold", description: "Offline interrupt fixture",
    parameters: Type.Object({}),
    execute: async (_id, _args, signal) => {
      await new Promise(resolve => {
        if (signal?.aborted) return resolve();
        let timer;
        const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
        signal?.addEventListener("abort", done, { once: true });
        if (process.env.PI_SUBAGENT_CAN_DELEGATE === "true") timer = setTimeout(done, 50);
      });
      return { content: [{ type: "text", text: "Interrupted fixture" }] };
    },
  });
  pi.registerProvider("rpc-fixture", {
    api: "rpc-fixture-api", baseUrl: "http://127.0.0.1:1", apiKey: "offline",
    models: [{ id: "model", name: "RPC fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const history = JSON.stringify(context.messages);
      const finish = history.includes("FINISH_NOW") || history.includes("RPC_FINISHED");
      const delegate = process.env.PI_SUBAGENT_CAN_DELEGATE === "true" && !context.messages.some(message =>
        message.role === "assistant" && message.content?.some(part => part.type === "toolCall" && part.name === "delegate"));
      const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: "toolUse", content: [],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        const toolCall = { type: "toolCall", id: `rpc-${context.messages.length}`,
          name: delegate ? "delegate" : finish ? "finish_task" : "hold_worker",
          arguments: delegate ? { agent: "leaf", name: "leaf", mode: process.env.RPC_FIXTURE_MODE || "async", parallel_work: "Independent parent fixture",
            task: { objective: "Wait for instructions", scope: { read: [], write: [] }, plan: ["Wait"], acceptance: ["Finish on request"] } }
            : finish ? { report: "RPC_FINISHED" } : {} };
        stream.push({ type: "start", partial: output });
        output.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
      });
      return stream;
    },
  });
}
