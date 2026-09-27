import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { startWorker } from "./core.ts";
import { createWorkerRpc } from "./rpc.ts";
import { createPool, DEFAULT_LIMITS } from "./limits.ts";

test("RPC controls wait for their own acknowledgement and reject errors, timeouts and exit", async () => {
  const wires = [];
  const rpc = createWorkerRpc(wire => wires.push(JSON.parse(wire)), 20);
  let settled = false;
  const control = rpc.request({ type: "prompt" }, "worker_control_result").then(() => { settled = true; });
  rpc.receive({ type: "response", id: wires[0].id, success: true });
  await Promise.resolve();
  assert.equal(settled, false);
  rpc.receive({ type: "worker_control_result", id: wires[0].id, success: true });
  await control;
  const bad = rpc.request({ type: "prompt" });
  rpc.receive({ type: "response", id: wires[1].id, success: false, error: "Rejected" });
  await assert.rejects(bad, /Rejected/);
  await assert.rejects(rpc.request({ type: "prompt" }), /timed out/);
  const ended = rpc.request({ type: "prompt" }); rpc.close();
  await assert.rejects(ended, /ended/);
});

async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw Error("Timed out waiting for worker state");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("real RPC worker steers, pauses twice, resumes in place, and finishes without tmux", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-rpc-"));
  const previous = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.TMUX = "/nonexistent-tmux,0,0"; process.env.TMUX_PANE = "%999999";
  process.env.PI_CODING_AGENT_DIR = root;
  let worker;
  try {
    worker = startWorker({
      agent: { name: "fixture", description: "RPC", model: "rpc-fixture/model", thinking: "off",
        callable: true, can_delegate: false, delegatable_agents: [], tools: ["hold_worker"], systemPrompt: "Offline fixture" },
      task: "Wait for instructions", cwd: root, runsDir: root,
      extensionPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
      toolExtensions: [fileURLToPath(new URL("./test-fixtures/rpc-provider.ts", import.meta.url))],
    });
    let done = false; worker.done.then(() => { done = true; });
    const started = await worker.ready;
    const events = () => readFile(join(started.runDir, "events.jsonl"), "utf8");
    await until(async () => (await events()).includes('"toolName":"hold_worker"'));
    await worker.message("STEER_MARKER");
    for (let i = 0; i < 2; i++) {
      await worker.interrupt();
      await until(() => worker.phase === "paused");
      assert.equal(done, false);
      assert.equal(JSON.parse(await readFile(join(started.runDir, "result.json"), "utf8")).status, "paused");
      await access(started.sessionFile + ".lock");
      if (i === 0) {
        await worker.resume("WAIT_AGAIN");
        await until(() => worker.phase === "running");
        await until(async () => (await events()).trim().split("\n").map(JSON.parse)
          .filter(event => event.type === "tool_execution_start" && event.toolName === "hold_worker").length >= 2);
      }
    }
    await worker.resume("FINISH_NOW");
    await until(() => done);
    const result = await worker.done;
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.output, "RPC_FINISHED");
    assert.equal(result.sessionFile, started.sessionFile);
    assert.ok(!(await readFile(result.sessionFile, "utf8")).includes("/worker-control"), "controls are never model prompts");
    await assert.rejects(access(started.sessionFile + ".lock"), { code: "ENOENT" });
    assert.ok(!(await events()).includes("tmux_worker_exit"));
  } finally {
    worker?.stop(); await worker?.done.catch(() => {});
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["async", "sync"]) test(`RPC routes controls to an owned descendant and rejects unknown runs (${mode})`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-rpc-tree-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldMode = process.env.RPC_FIXTURE_MODE;
  process.env.RPC_FIXTURE_MODE = mode;
  process.env.PI_CODING_AGENT_DIR = root;
  let worker;
  try {
    await writeFile(join(root, "subagents.json"), '{"max_depth":2}');
    await mkdir(join(root, "subagents"));
    await writeFile(join(root, "subagents/leaf.md"), `---
name: leaf
description: Offline leaf
model: rpc-fixture/model
thinking: off
callable: true
can_delegate: false
delegatable_agents: []
tools: [hold_worker]
---
Offline leaf fixture.
`);
    const descendants = new Map();
    const runsDir = join(root, "subagent-runs");
    worker = startWorker({
      agent: { name: "parent", description: "RPC", model: "rpc-fixture/model", thinking: "off",
        callable: true, can_delegate: true, delegatable_agents: ["leaf"], tools: ["hold_worker"], systemPrompt: "Offline fixture" },
      task: "Delegate and wait", cwd: root, runsDir, runId: randomUUID(), pool: await createPool(runsDir),
      limits: { ...DEFAULT_LIMITS, max_depth: 2 },
      extensionPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
      toolExtensions: [fileURLToPath(new URL("./test-fixtures/rpc-provider.ts", import.meta.url))],
      onDescendant: row => descendants.set(row.runId, row),
    });
    let done = false;
    worker.done.then(() => { done = true; });
    const started = await worker.ready;
    try { await until(() => [...descendants.values()].some(row => row.activity === "hold_worker")); }
    catch (error) {
      throw new Error(`${error.message}: ${JSON.stringify([...descendants.values()])}\n` +
        (await readFile(join(started.runDir, "events.jsonl"), "utf8")).slice(0, 16000));
    }
    const childId = [...descendants.keys()][0];
    await assert.rejects(worker.control({ runId: "not-owned", action: "pause" }), /no longer controlled/);
    await worker.control({ runId: childId, action: "pause" });
    await until(() => descendants.get(childId)?.status === "paused");
    assert.equal(worker.phase, "running", "pausing a descendant does not pause its parent");
    await worker.interrupt();
    assert.equal(worker.phase, "paused");
    await worker.resume("WAIT_PARENT");
    await until(() => worker.phase === "running" && descendants.get(childId)?.status === "running");
    await worker.control({ runId: childId, action: "message", prompt: "FINISH_NOW" });
    // Steering waits behind the leaf's deliberately blocked tool; pause and
    // resume it to let the queued correction reach the next turn.
    await worker.control({ runId: childId, action: "pause" });
    await worker.control({ runId: childId, action: "resume" });
    await until(() => done);
    const result = await worker.done;
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(descendants.get(childId)?.status, "completed");
  } finally {
    worker?.stop(); await worker?.done.catch(() => {});
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldMode === undefined) delete process.env.RPC_FIXTURE_MODE; else process.env.RPC_FIXTURE_MODE = oldMode;
    await rm(root, { recursive: true, force: true });
  }
});
