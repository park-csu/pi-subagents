#!/usr/bin/env node
// Offline fake pi. Runs the REAL dispatcher, but never contacts a provider.
import assert from "node:assert/strict";
import { loadFixtureRuntime } from "./runtime.mjs";
import { writeFile, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

// Match JSON-mode stdout takeover. Only the simulated engine may emit events;
// extension writes must never accidentally make this test pass.
const rawWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (...args) => process.stderr.write(...args);
const emit = event => rawWrite(JSON.stringify(event) + "\n");
let task = "";
let rpcInput;
if (process.env.PI_SUBAGENT_RPC === "1") {
  rpcInput = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const command = JSON.parse((await rpcInput.next()).value);
  task = command.message;
  emit({ type: "response", id: command.id, command: "prompt", success: true });
} else for await (const chunk of process.stdin) task += chunk;
let completions = 0, notifyDone;
const childrenDone = new Promise(resolve => { notifyDone = resolve; });
const { tool, ctx, extension, userMessages } = await loadFixtureRuntime(message => {
  if (message.customType !== "subagent-completion") return;
  if (message.details.status !== "completed") throw new Error("Nested fixture failed");
  assert.ok(message.content.includes(`Tickets: ${process.env.PI_SUBAGENT_TICKETS}`),
    "nested workers inherit their immediate parent's mode");
  emit({ type: "message_end", message: { role: "custom", ...message } });
  if (++completions === 2) notifyDone();
});
if (rpcInput) void (async () => {
  for await (const line of { [Symbol.asyncIterator]: () => rpcInput }) {
    const command = JSON.parse(line);
    if (command.message?.startsWith("/worker-control ")) {
      await extension.commands.get("worker-control").handler(command.message.slice(16), ctx);
    }
    emit({ type: "response", id: command.id, command: command.type, success: true });
  }
})();
const contract = objective => ({ objective, scope: { read: [], write: [] }, plan: ["Inspect evidence"], acceptance: ["Return findings"] });
const depth = Number(process.env.PI_SUBAGENT_DEPTH);
const finishTool = extension.tools.get("finish_task").definition;
for (const report of ["", " \n", "x".repeat(12001)]) {
  await assert.rejects(finishTool.execute("invalid-finish", { report }), /report/);
}
const limits = JSON.parse(process.env.PI_SUBAGENT_LIMITS);
const args = process.argv.slice(2);
const sessionFile = args[args.indexOf("--session") + 1];
if (args.includes("--session")) {
  try { await writeFile(sessionFile, JSON.stringify({ type: "session", id: randomUUID(), cwd: process.cwd() }) + "\n", { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  await appendFile(sessionFile, JSON.stringify({ type: "message", message: { role: "user", content: task } }) + "\n");
}
const cliTools = args[args.indexOf("--tools") + 1].split(",");
if (JSON.stringify(cliTools) !== process.env.PI_SUBAGENT_TOOLS) throw new Error("CLI tool mismatch");
if (Boolean(tool) !== (depth < limits.max_depth)) throw new Error("Depth gate mismatch");
let systemPrompt = "Worker role and repository instructions.";
for (const handler of extension.handlers.get("before_agent_start") ?? []) {
  const result = await handler({ systemPrompt }, ctx);
  systemPrompt = result?.systemPrompt ?? systemPrompt;
}
assert.ok(systemPrompt.startsWith("Worker role and repository instructions."));
assert.match(systemPrompt, /You are a subagent providing scoped assistance, not the primary agent/);
assert.doesNotMatch(systemPrompt, /You are the primary agent:|Handle the request directly/);
assert.equal(systemPrompt.includes("Callable subagents"), Boolean(tool));
assert.equal(extension.commands.has("tickets"), false, "only the primary session controls ticket mode");
assert.ok(systemPrompt.includes(`Ticket workflow: ${process.env.PI_SUBAGENT_TICKETS === "on" ? "ON" : "OFF"}`));
if (tool) {
  assert.match(systemPrompt, /Handle tiny tasks, known-path reads, and simple lookups directly/);
  assert.match(systemPrompt, /protected tests and checks/);
  assert.match(systemPrompt, /never bypass limits through bash/);
}
for (const handler of extension.handlers.get("before_provider_request") ?? []) await handler({}, ctx);
for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, ctx);
for (const handler of extension.handlers.get("agent_start") ?? []) await handler({}, ctx);
if (task.includes("FAIL_AFTER_START")) process.exit(4);

emit({ type: "message_update",
  assistantMessageEvent: { type: "thinking_delta", delta: `Fixture depth ${depth}: examining evidence` } });
if (tool) {
  assert.deepEqual(JSON.parse(process.env.PI_SUBAGENT_DELEGATABLE_AGENTS), ["researcher"]);
  await assert.rejects(tool.execute("forbidden-role", { agent: "blocked", task: contract("Forbidden") },
    undefined, undefined, ctx), /not permitted/);
  const results = await Promise.all(["A", "B"].map(async (name, i) => {
    const toolCallId = `nested-${i}`;
    const result = await tool.execute(toolCallId,
      { agent: "researcher", task: contract(`Question ${name}`), mode: "async", parallel_work: "Launch independent sibling question" }, undefined,
      partialResult => emit({ type: "tool_execution_update", toolName: "delegate", toolCallId, partialResult }), ctx);
    emit({ type: "tool_execution_end", toolName: "delegate", toolCallId, result, isError: false });
    return result;
  }));
  for (const result of results) {
    if (result.details.status !== "running") throw new Error("Nested fixture did not acknowledge startup");
    emit({ type: "message_end", message: { role: "toolResult", usage: result.usage } });
  }
  await assert.rejects(finishTool.execute("premature-finish", { report: "Too early" }), /Owned workers/);
  await childrenDone;
} else {
  emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: {} });
  await new Promise(resolve => setTimeout(resolve, 250));
  emit({ type: "tool_execution_end", toolCallId: "read-1", isError: false });
}
if (task.includes("Root 3")) await new Promise(resolve => setTimeout(resolve, 900));
emit({ type: "message_end", message: {
  role: "assistant", stopReason: "stop", content: [{ type: "text",
    text: `Fixture depth ${depth} completed\n${userMessages.map(message => message.text).join("\n")}` }],
  usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.01 } },
} });
const report = `Fixture depth ${depth} completed\nTickets: ${process.env.PI_SUBAGENT_TICKETS}\n${userMessages.map(message => message.text).join("\n")}`;
const finished = await extension.tools.get("finish_task").definition.execute("finish", { report });
for (const handler of extension.handlers.get("tool_execution_end") ?? []) {
  await handler({ type: "tool_execution_end", toolName: "finish_task", result: finished, isError: false }, ctx);
}
for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
if (rpcInput) {
  await new Promise(resolve => rawWrite("", resolve));
  process.exit(0);
}
