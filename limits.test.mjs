import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createPool, acquireSlot, acquireChildSlot, acquireWorkerSlots, validateLimits, loadLimits } from "./limits.ts";
import { authorize, childArgs } from "./core.ts";

test("strict configurable limits, inherited snapshot and configurable depth", async () => {
  assert.deepEqual(validateLimits({}), { max_parallel: 6, max_depth: 1, max_children: 3, max_nested_children: 1 });
  for (const value of [{ max_parallel: 0 }, { max_depth: 9 }, { max_depth: 1.5 },
    { max_children: 0 }, { max_nested_children: 65 }, { max_parallel: "16" }, { toString: 1 }, null]) {
    assert.throws(() => validateLimits(value));
  }
  const root = await mkdtemp(join(tmpdir(), "subagent-limits-"));
  try {
    await writeFile(join(root, "subagents.json"), '{"max_parallel":4,"max_depth":3}');
    assert.deepEqual(loadLimits(root), { max_parallel: 4, max_depth: 3, max_children: 3, max_nested_children: 1 });
    assert.deepEqual(loadLimits(root, '{"max_parallel":2,"max_depth":1}'),
      { max_parallel: 2, max_depth: 1, max_children: 3, max_nested_children: 1 });
    await writeFile(join(root, "subagents.json"), "broken");
    assert.throws(() => loadLimits(root));
  } finally { await rm(root, { recursive: true, force: true }); }
  const agent = { callable: true, can_delegate: true, delegatable_agents: ["worker"], tools: ["read"], model: "p/m", thinking: "low" };
  authorize(agent, { depth: 2, maxDepth: 3 });
  assert.throws(() => authorize(agent, { depth: 3, maxDepth: 3 }));
  const args = childArgs(agent, "e", "p", [], false);
  assert.equal(args[args.indexOf("--tools") + 1], "read,finish_task");
});

test("sixteen global slots are atomic, released, and abort-aware", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-slots-"));
  try {
    const pool = await createPool(root);
    const results = await Promise.allSettled(Array.from({ length: 32 }, () => acquireSlot(pool, 16)));
    const acquired = results.filter(result => result.status === "fulfilled").map(result => result.value);
    assert.equal(acquired.length, 16);
    assert.equal((await readdir(pool)).length, 16);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(acquireSlot(pool, 16, aborted.signal), { name: "AbortError" });
    await Promise.all(acquired.map(release => release()));
    assert.deepEqual(await readdir(pool), []);
    const release = await acquireSlot(pool, 16);
    await release();
    await release(); // Idempotent release.
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("slot accounting supports an explicitly enabled nested topology", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-topology-"));
  try {
    const pool = await createPool(root);
    const parents = await Promise.all(Array.from({ length: 3 }, () =>
      acquireWorkerSlots(pool, 6, "root", 3)));
    await assert.rejects(acquireWorkerSlots(pool, 6, "root", 3), /Child limit reached/);

    const children = await Promise.all(Array.from({ length: 3 }, (_, i) =>
      acquireWorkerSlots(pool, 6, `parent-${i}`, 1)));
    const reservations = await readdir(pool);
    assert.equal(reservations.filter(name => name.startsWith("slot-")).length, 6);
    assert.equal(reservations.filter(name => name.startsWith("parent-")).length, 6);

    // The shared pool has room after one unrelated worker is released, but
    // this parent still owns its one nested-child reservation.
    await parents[0]();
    await assert.rejects(acquireWorkerSlots(pool, 6, "parent-0", 1), /Child limit reached/);

    await Promise.all([...parents.slice(1), ...children].map(release => release()));
    const replacement = await acquireWorkerSlots(pool, 6, "parent-0", 1);
    await replacement();
    assert.deepEqual(await readdir(pool), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shared acquisition failure rolls back the parent slot and abort leaves no slot", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-slot-rollback-"));
  try {
    const pool = await createPool(root);
    const occupied = await acquireSlot(pool, 1);
    await assert.rejects(acquireWorkerSlots(pool, 1, "parent", 1), /Parallel worker limit reached/);
    const parent = await acquireChildSlot(pool, "parent", 1);
    await parent();
    await occupied();

    const safe = await acquireChildSlot(pool, "../../outside", 1);
    assert.ok((await readdir(pool)).every(name => !name.includes("..")));
    await safe();
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(acquireWorkerSlots(pool, 6, "../../outside", 1, aborted.signal), { name: "AbortError" });
    assert.deepEqual(await readdir(pool), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("nested processes share the same pool rather than multiplying the limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-process-slots-"));
  let child;
  try {
    const pool = await createPool(root);
    const releaseParent = await acquireSlot(pool, 2);
    const source = `
      import { acquireSlot } from ${JSON.stringify(new URL("./limits.ts", import.meta.url).href)};
      const release = await acquireSlot(process.argv[1], 2);
      console.log("ready");
      process.stdin.resume();
      process.stdin.on("end", async () => { await release(); });
    `;
    child = spawn(process.execPath, ["--input-type=module", "-e", source, pool], { stdio: ["pipe", "pipe", "inherit"] });
    const closed = once(child, "close");
    const [buffer] = await once(child.stdout, "data");
    assert.match(buffer.toString(), /ready/);
    await assert.rejects(acquireSlot(pool, 2), /limit reached/);
    child.stdin.end();
    assert.equal((await closed)[0], 0);
    const release = await acquireSlot(pool, 2);
    await release();
    await releaseParent();
    assert.deepEqual(await readdir(pool), []);
  } finally {
    child?.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
