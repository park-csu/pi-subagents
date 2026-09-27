import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

test("finish_task validates reports, rejects parallel handoff and outstanding children", async () => {
  const packageRoot = process.env.PI_TEST_PACKAGE_ROOT ??
    join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
      "@earendil-works/pi-coding-agent");
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(
    join(packageRoot, "dist/core/extensions/loader.js")).href);
  const root = await mkdtemp(join(tmpdir(), "finish-task-tool-"));
  try {
    const fixture = join(root, "fixture.ts");
    await writeFile(fixture, `
      import { installFinishTask } from ${JSON.stringify(fileURLToPath(new URL("./finish-task.ts", import.meta.url)))};
      export default function(pi) {
        let busy = false;
        pi.on("agent_start", () => { busy = true; });
        pi.on("agent_end", () => { busy = false; });
        installFinishTask(pi, () => busy);
      }
    `);
    const messages = [];
    const runtime = createExtensionRuntime();
    runtime.sendMessage = (message, options) => messages.push({ message, options });
    const loaded = await loadExtensions([fixture], root, undefined, runtime);
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    const tool = extension.tools.get("finish_task").definition;
    const fire = async (name, event = {}, ctx = {}) => {
      for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
    };
    const prose = { message: { role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: "Done." }] } };
    await fire("message_end", prose);
    assert.equal(messages.length, 1);
    assert.match(messages[0].message.content, /finish_task/);
    assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
    for (const stopReason of ["aborted", "error", "toolUse", "length"]) {
      await fire("message_end", { message: { ...prose.message, stopReason } });
    }
    await fire("message_end", prose, { signal: { aborted: true } });
    await fire("message_end", { message: { role: "toolResult" } });
    assert.equal(messages.length, 1, "interrupts, errors and tool traffic do not trigger reminders");
    for (const report of [undefined, "", " \n", "x".repeat(12001)]) {
      await assert.rejects(tool.execute("finish", { report }), /report/);
    }
    await fire("agent_start");
    await fire("message_end", prose);
    assert.equal(messages.length, 1, "do not restart parents waiting on owned workers");
    await assert.rejects(tool.execute("finish", { report: "Done" }), /Owned workers/);
    await fire("agent_end");
    await fire("message_end", { message: { role: "assistant", content: [
      { type: "toolCall", name: "write" }, { type: "toolCall", name: "finish_task" },
    ] } });
    await assert.rejects(tool.execute("finish", { report: "Done" }), /alone/);
    await fire("message_end", { message: { role: "assistant",
      content: [{ type: "toolCall", name: "finish_task" }] } });
    const result = await tool.execute("finish", { report: "Tests passed; visual check pending." });
    assert.equal(result.terminate, true);
    assert.equal(result.details.finishTask.report, "Tests passed; visual check pending.");
    await fire("tool_execution_end", { toolName: "finish_task", result, isError: false });
    await fire("message_end", prose);
    assert.equal(messages.length, 1, "no reminder after successful handoff");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
