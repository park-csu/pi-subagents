import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerName, readLoadout } from "./session-store.ts";

test("worker names are unique and saved sessions enforce schema, containment and original cwd", async () => {
  const records = new Map([["researcher", {}]]);
  assert.equal(workerName(records, "researcher"), "researcher-2");
  assert.throws(() => workerName(records, "researcher", "researcher"), /already exists/);
  assert.throws(() => workerName(records, "researcher", "../escape"), /Worker name/);
  const root = await mkdtemp(join(tmpdir(), "worker-store-"));
  try {
    const runs = join(root, "runs"), run = join(runs, "one"), sessionFile = join(run, "session.jsonl");
    await mkdir(run, { recursive: true });
    const data = { version: 2, task: "Original contract", cwd: root, toolExtensions: [],
      limits: { max_parallel: 16, max_depth: 2 }, sessionFile,
      agent: { name: "researcher", description: "Test", model: "test/model", thinking: "off",
        callable: true, can_delegate: false, tools: ["read"], systemPrompt: "Test" } };
    const save = () => writeFile(join(run, "loadout.json"), JSON.stringify(data));
    await save();
    await writeFile(sessionFile, JSON.stringify({ type: "session", id: "test", cwd: root }) + "\n");
    const loaded = await readLoadout(run, runs);
    assert.equal(loaded.task, data.task);
    assert.deepEqual(loaded.limits, { max_parallel: 16, max_depth: 2, max_children: 3, max_nested_children: 1 });
    data.contract = { objective: "Original contract", scope: { read: [], write: [] }, plan: ["Inspect"], acceptance: ["Evidence returned"] };
    await save();
    assert.deepEqual((await readLoadout(run, runs)).contract, data.contract);
    data.contract.acceptance = [];
    await save();
    await assert.rejects(readLoadout(run, runs), /JSON contract/);
    delete data.contract;
    data.version = 1; await save();
    await assert.rejects(readLoadout(run, runs), /Unsupported/);
    data.version = 2;
    await writeFile(join(root, "outside"), "{}\n");
    await symlink(join(root, "outside"), join(run, "escape"));
    data.sessionFile = join(run, "escape"); await save();
    await assert.rejects(readLoadout(run, runs), /escapes/);
    data.sessionFile = sessionFile; await save();
    await writeFile(sessionFile, JSON.stringify({ type: "session", id: "test", cwd: runs }) + "\n");
    await assert.rejects(readLoadout(run, runs), /working directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
