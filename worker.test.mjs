import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorker } from "./core.ts";

const agent = { name: "fixture", description: "Offline worker", model: "fixture/model", thinking: "off",
  callable: true, can_delegate: false, tools: [], systemPrompt: "Offline test only" };
const finalMessage = { type: "message_end", message: {
  role: "assistant", stopReason: "stop", content: [{ type: "text", text: "FINAL_OK" }],
} };

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "worker-lifetime-"));
  try {
    await run({ agent, task: "Offline", cwd: root, runsDir: root, extensionPath: "/unused",
      command: process.execPath, killGraceMs: 50, transport: "json" }, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

const prefix = script => ["--input-type=module", "-e", script, "--"];
const emitHandoff = `console.log(JSON.stringify({type:"worker_task_done", report:"FINAL_OK"}));`;
const emitFinal = `console.log(${JSON.stringify(JSON.stringify(finalMessage))}); ${emitHandoff}`;

// ready must describe a started session, not merely a successfully spawned process.
test("worker startup failure rejects ready and finishes cleanup before done", { timeout: 5000 }, async () => {
  await fixture(async options => {
    let prepared;
    const worker = startWorker({ ...options, command: "/nonexistent-pi-worker",
      onPrepared: value => { prepared = value; } });
    await assert.rejects(worker.ready, /ENOENT/);
    const result = await worker.done;
    assert.equal(result.status, "failed");
    assert.equal(worker.phase, "ended");
    await assert.rejects(access(prepared.sessionFile + ".lock"), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(join(prepared.runDir, "result.json"), "utf8")).status, "failed");
    worker.stop();
    worker.interrupt();
    assert.equal(worker.resume(), undefined);
    assert.throws(() => worker.message("Too late"), /ended/);
    assert.equal(await worker.done, result);
  });
});

test("shutdown during setup prevents spawning and rejects both handle promises", { timeout: 5000 }, async () => {
  await fixture(async (options, root) => {
    let prepared, releaseSetup, enteredSetup;
    const setup = new Promise(resolve => { enteredSetup = resolve; });
    const gate = new Promise(resolve => { releaseSetup = resolve; });
    const spawned = join(root, "should-not-exist");
    const worker = startWorker({ ...options,
      prefix: prefix(`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(spawned)}, 'spawned');`),
      onPrepared: value => { prepared = value; enteredSetup(); return gate; } });
    await setup;
    worker.stop();
    worker.stop();
    assert.equal(worker.phase, "stopping");
    releaseSetup();
    await assert.rejects(worker.ready, { name: "AbortError" });
    await assert.rejects(worker.done, { name: "AbortError" });
    assert.equal(worker.phase, "ended");
    await assert.rejects(access(spawned), { code: "ENOENT" });
    await assert.rejects(access(prepared.sessionFile + ".lock"), { code: "ENOENT" });
  });
});

test("shared decoder preserves fragmented records from both channels and final unterminated records", async () => {
  await fixture(async options => {
    const script = `
      import {writeSync} from 'node:fs';
      const ready = JSON.stringify({type:'worker_ready'})+'\\n';
      writeSync(3,ready.slice(0,7));
      process.stdout.write(' {"type":"message_start"}\\n');
      writeSync(3,ready.slice(7));
      ${emitHandoff}
      process.stdout.write(${JSON.stringify(JSON.stringify(finalMessage))});
    `;
    const worker = startWorker({ ...options, prefix: prefix(script) });
    const started = await worker.ready;
    const result = await worker.done;
    assert.equal(result.output, "FINAL_OK");
    assert.equal(result.status, "completed");
    const records = (await readFile(join(started.runDir, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 4);
    await assert.rejects(access(started.sessionFile + ".lock"), { code: "ENOENT" });
  });
});

test("ordinary final prose without finish_task is a failed handoff", async () => {
  await fixture(async options => {
    const worker = startWorker({ ...options, prefix: prefix(
      `console.log(JSON.stringify({type:"worker_ready"})); console.log(${JSON.stringify(JSON.stringify(finalMessage))});`) });
    await worker.ready;
    const result = await worker.done;
    assert.equal(result.status, "failed");
    assert.match(result.error, /without calling finish_task/);
    assert.equal(result.output, "FINAL_OK", "retain partial prose for diagnosis");
  });
});

test("result persistence failure rejects done after releasing the session lock", async () => {
  await fixture(async options => {
    const worker = startWorker({ ...options,
      prefix: prefix(`console.log(JSON.stringify({type:'worker_ready'})); ${emitFinal}`),
      onPrepared: async ({ runDir }) => { await mkdir(join(runDir, "result.json")); } });
    const started = await worker.ready;
    await assert.rejects(worker.done, { code: "EISDIR" });
    assert.equal(worker.phase, "ended");
    await assert.rejects(access(started.sessionFile + ".lock"), { code: "ENOENT" });
  });
});

test("a final answer without the session startup event cannot acknowledge startup", async () => {
  await fixture(async options => {
    const worker = startWorker({ ...options, prefix: prefix(emitFinal) });
    await assert.rejects(worker.ready, /before session startup/);
    assert.equal((await worker.done).status, "completed");
  });
});
