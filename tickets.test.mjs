import { test } from "node:test";
import assert from "node:assert/strict";
import { installTickets } from "./tickets.ts";

function fixture(depth = 0, initial = []) {
  const handlers = new Map(), commands = new Map(), notices = [], entries = [...initial];
  let branch = entries, idle = true;
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  };
  const ctx = {
    sessionManager: { getBranch: () => branch },
    isIdle: () => idle,
    ui: { notify: (...args) => notices.push(args) },
  };
  const state = installTickets(pi, depth);
  return {
    state, entries, commands, notices, ctx,
    run: () => state.beginRun(),
    dispatch: () => state.forDispatch(ctx),
    command: args => commands.get("tickets").handler(args, ctx),
    restore(event = "session_start") { handlers.get(event)({}, ctx); },
    setBranch(value) { branch = value; },
    setIdle(value) { idle = value; },
  };
}

const entry = enabled => ({ type: "custom", customType: "subagents-tickets", data: { enabled } });

test("tickets defaults off; status, invalid input and repeated values do not persist changes", async () => {
  const f = fixture();
  f.restore();
  assert.equal(f.run(), false);
  await f.command("");
  assert.match(f.notices.at(-1)[0], /Tickets: off/);
  await f.command("off");
  await f.command("on off");
  assert.deepEqual(f.notices.at(-1), ["Usage: /tickets [on|off]", "warning"]);
  assert.equal(f.entries.length, 0);
  await f.command(" on ");
  assert.deepEqual(f.entries, [entry(true)]);
  assert.equal(f.dispatch(), true, "idle manual worker launch uses selected mode");
  await f.command("on");
  assert.equal(f.entries.length, 1);
  assert.deepEqual(f.commands.get("tickets").getArgumentCompletions("of"), [{ value: "off", label: "off" }]);
  assert.deepEqual(f.commands.get("tickets").getArgumentCompletions("x"), []);
});

test("changes during a run are deferred, including that run's worker launches", async () => {
  const f = fixture();
  f.run();
  f.setIdle(false);
  await f.command("on");
  assert.equal(f.dispatch(), false);
  assert.equal(f.state.active, false);
  assert.match(f.notices.at(-1)[0], /next agent run; current run remains off/);
  assert.equal(f.run(), true);
  assert.equal(f.dispatch(), true);
  await f.command("off");
  assert.equal(f.dispatch(), true);
  assert.equal(f.run(), false);
  assert.equal(f.dispatch(), false);
});

test("reload/resume reconstruct from the active branch; new sessions and tree navigation reset", async () => {
  const f = fixture();
  await f.command("on");
  const restored = fixture(0, f.entries);
  restored.restore();
  assert.equal(restored.run(), true);
  restored.setBranch([entry(true), { type: "compaction" }, entry(false)]);
  restored.restore("session_tree");
  assert.equal(restored.run(), false);
  restored.setBranch([entry(true)]);
  restored.restore("session_tree");
  assert.equal(restored.run(), true);
  restored.setBranch([]);
  restored.restore();
  assert.equal(restored.run(), false);
});

test("malformed and unrelated custom entries do not change the last valid selection", () => {
  const f = fixture(0, [
    entry(true), entry("off"), { type: "custom", customType: "other", data: { enabled: false } },
    { type: "custom", customType: "subagents-tickets", data: null },
  ]);
  f.restore();
  assert.equal(f.run(), true);
});

test("tree restoration during a run cannot overwrite its mode snapshot", async () => {
  const f = fixture();
  await f.command("on");
  assert.equal(f.run(), true);
  f.setIdle(false);
  f.setBranch([entry(false)]);
  f.restore("session_tree");
  assert.equal(f.dispatch(), true);
  assert.equal(f.state.active, true);
  assert.equal(f.run(), false);
  assert.equal(f.dispatch(), false);
});

test("only workers inherit the launch snapshot; live workers cannot toggle or follow env changes", () => {
  const previous = process.env.PI_SUBAGENT_TICKETS;
  try {
    process.env.PI_SUBAGENT_TICKETS = "on";
    const root = fixture();
    root.restore();
    assert.equal(root.run(), false);
    const worker = fixture(1, [entry(false)]);
    worker.restore();
    assert.equal(worker.run(), true);
    assert.equal(worker.commands.has("tickets"), false);
    process.env.PI_SUBAGENT_TICKETS = "off";
    worker.restore();
    assert.equal(worker.run(), true);
    const nested = fixture(2, [entry(true)]);
    nested.restore();
    assert.equal(nested.run(), false, "new/restored workers obey launch mode, not stale session entries");
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_TICKETS;
    else process.env.PI_SUBAGENT_TICKETS = previous;
  }
});
