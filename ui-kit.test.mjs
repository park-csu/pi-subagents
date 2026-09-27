import test from "node:test";
import assert from "node:assert/strict";
import { WorkerWidget } from "./activity.ts";
import { installUiPanels, UI_PANELS_PROBE, UI_PANELS_READY, UI_PANELS_STOPPED } from "./ui-kit.ts";

function bus() {
  const listeners = new Map();
  return {
    on(name, listener) {
      const current = listeners.get(name) ?? [];
      current.push(listener);
      listeners.set(name, current);
      return () => listeners.set(name, current.filter(item => item !== listener));
    },
    emit(name, payload) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(payload);
    },
  };
}

const worker = (id, extra = {}) => ({
  runId: id, parentRunId: "", agent: id, goal: "goal", status: "running",
  activity: "read", startedAt: Date.now(), elapsedMs: 0, turns: 1, ...extra,
});

test("panel discovery probes synchronously without acting as a host", () => {
  const events = bus();
  const ready = [];
  events.on(UI_PANELS_READY, host => ready.push(host));
  const upserts = [];
  const host = {
    upsert(panel) { upserts.push(panel); },
    remove() {},
  };
  events.on(UI_PANELS_PROBE, ({ accept }) => accept(host));

  const widget = new WorkerWidget({ truncate: (text, width) => text.slice(0, width) });
  const client = installUiPanels({ events }, widget);
  const ui = { setWidget() {}, requestRender() {} };
  client.start({ mode: "tui", hasUI: true, ui });
  widget.update(worker("root"));

  assert.equal(client.host, host);
  assert.equal(ready.length, 0, "clients do not republish the host-ready event");
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].id, "subagents:workers");
  assert.equal(upserts[0].order, 200);
  assert.equal(upserts[0].animated, true);
  assert.equal(widget.timer, undefined, "the host owns animation");
  client.stop();
});

test("host panel is stable, renders supplied clock data, and detaches stale hosts", () => {
  const events = bus();
  const upserts = [];
  const removed = [];
  const host = {
    upsert(panel) { upserts.push(panel); },
    remove(id) { removed.push(id); },
  };
  const widget = new WorkerWidget({ truncate: (text, width) => text.slice(0, width) });
  const client = installUiPanels({ events }, widget);
  const ui = { setWidget() {}, requestRender() {} };
  client.start({ mode: "tui", hasUI: true, ui });
  events.emit(UI_PANELS_READY, host);

  widget.update(worker("root", { startedAt: 900, activity: "Searching" }));
  const panel = upserts.at(-1);
  assert.equal(panel.render(80, {}, { now: 1000, frame: 3 })[1].startsWith("⠸ root"), true);
  widget.update(worker("root", { startedAt: 900, activity: "Current activity" }));
  assert.equal(upserts.at(-1), panel);
  assert.match(panel.render(80, {}, { now: 1000, frame: 3 })[1], /Current activity/);

  events.emit(UI_PANELS_STOPPED, { upsert() {}, remove() {} });
  assert.deepEqual(removed, [], "an unrelated stopped host is ignored");
  events.emit(UI_PANELS_STOPPED, host);
  assert.deepEqual(removed, ["subagents:workers"]);
  widget.dispose();
});

test("session stop removes bus listeners and a new session starts from no cached host", () => {
  const events = bus();
  const host = { upsert() {}, remove() {} };
  const widget = new WorkerWidget({ truncate: (text, width) => text.slice(0, width) });
  const client = installUiPanels({ events }, widget);
  const firstUI = { setWidget() {} };
  client.start({ mode: "tui", hasUI: true, ui: firstUI });
  events.emit(UI_PANELS_READY, host);
  assert.equal(client.host, host);
  client.stop();

  events.emit(UI_PANELS_READY, host);
  assert.equal(client.host, undefined, "late events from a stopped session are ignored");

  const secondUI = { setWidget() {} };
  client.start({ mode: "tui", hasUI: true, ui: secondUI });
  assert.equal(client.host, undefined, "hosts are not retained across sessions");
  events.emit(UI_PANELS_READY, host);
  assert.equal(client.host, host);
  client.stop();
});

test("a delayed probe callback from an older session cannot adopt its host", () => {
  const events = bus();
  const probes = [];
  events.on(UI_PANELS_PROBE, ({ accept }) => probes.push(accept));
  const widget = new WorkerWidget({ truncate: (text, width) => text.slice(0, width) });
  const client = installUiPanels({ events }, widget);
  const ui = { setWidget() {} };
  client.start({ mode: "tui", hasUI: true, ui });
  client.stop();
  client.start({ mode: "tui", hasUI: true, ui });

  const staleHost = { upsert() {}, remove() {} };
  probes[0](staleHost);
  assert.equal(client.host, undefined);
  probes[1](staleHost);
  assert.equal(client.host, staleHost);
  client.stop();
});

test("fallback registers once, captures the real TUI renderer, and leaves no timers after dispose", async () => {
  const events = bus();
  const calls = [];
  let renders = 0;
  const tui = { requestRender() { renders++; } };
  const ui = {
    setWidget(key, value) {
      calls.push([key, value]);
      if (value) value(tui).render(80);
    },
  };
  const widget = new WorkerWidget({ tickMs: 5, settleMs: 10, truncate: (text, width) => text.slice(0, width) });
  const client = installUiPanels({ events }, widget);
  client.start({ mode: "tui", hasUI: true, ui });
  widget.update(worker("root"));
  widget.update(worker("root", { activity: "changed" }));
  assert.equal(calls.filter(([key, value]) => key === "subagent-worker" && value).length, 1);
  assert.ok(renders > 0);

  const host = { upsert() {}, remove() {} };
  events.emit(UI_PANELS_READY, host);
  events.emit(UI_PANELS_STOPPED, host);
  assert.equal(calls.filter(([key, value]) => key === "subagent-worker" && value).length, 2);
  assert.equal(widget.timer === undefined, false);

  client.stop();
  const before = renders;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(widget.timer, undefined);
  assert.equal(widget.settlementTimer, undefined);
  assert.equal(renders, before);
});

test("a settled managed panel can accept a later run without falling back", async () => {
  const events = bus();
  const upserts = [];
  const removed = [];
  const host = {
    upsert(panel) { upserts.push(panel); },
    remove(id) { removed.push(id); },
  };
  const calls = [];
  const widget = new WorkerWidget({ settleMs: 10, truncate: (text, width) => text.slice(0, width) });
  const client = installUiPanels({ events }, widget);
  client.start({
    mode: "tui",
    hasUI: true,
    ui: { setWidget(key, value) { calls.push([key, value]); } },
  });
  events.emit(UI_PANELS_READY, host);
  widget.update(worker("first", { status: "completed" }));
  const deadline = Date.now() + 200;
  while (!removed.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(removed, ["subagents:workers"]);
  const beforeSecond = upserts.length;
  widget.update(worker("second"));
  assert.equal(upserts.length, beforeSecond + 1);
  assert.equal(upserts.at(-1).id, "subagents:workers");
  assert.equal(calls.length, 0, "a live host remains connected after emptying");
  client.stop();
});

test("paused fallback rows disappear and resume without retaining animation", async () => {
  const events = bus();
  let ticks = 0;
  const tui = { requestRender() { ticks++; } };
  let component;
  const ui = {
    setWidget(_key, value) {
      component = value ? value(tui) : undefined;
    },
  };
  const widget = new WorkerWidget({ tickMs: 5, settleMs: 20, truncate: (text, width) => text.slice(0, width) });
  const client = installUiPanels({ events }, widget);
  client.start({ mode: "tui", hasUI: true, ui });
  widget.update(worker("root"));
  assert.equal(component.render(80).length, 2);
  widget.update(worker("root", { status: "paused" }));
  assert.equal(widget.timer, undefined);
  assert.equal(component, undefined);
  const afterUpdate = ticks;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(ticks, afterUpdate);
  widget.update(worker("root"));
  assert.equal(component.render(80).length, 2);
  assert.ok(widget.timer);
  client.stop();
});

test("finished ancestors are hidden without hiding active descendants", async () => {
  const events = bus();
  const removed = [];
  const host = { upsert() {}, remove(id) { removed.push(id); } };
  const widget = new WorkerWidget({ settleMs: 10, truncate: (text, width) => text.slice(0, width) });
  const client = installUiPanels({ events }, widget);
  client.start({ mode: "tui", hasUI: true, ui: { setWidget() {}, requestRender() {} } });
  events.emit(UI_PANELS_READY, host);
  widget.update(worker("root"));
  widget.update(worker("child", { parentRunId: "root" }));
  widget.update(worker("root", { status: "completed" }));
  await new Promise(resolve => setTimeout(resolve, 14));
  assert.deepEqual(removed, [], "the panel remains while the child row is active");
  const lines = widget.renderPanel(80);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /child/);
  assert.doesNotMatch(lines.join("\n"), /root|completed/);
  widget.update(worker("child", { parentRunId: "root", status: "completed" }));
  assert.deepEqual(widget.renderPanel(80), []);
  assert.equal(removed.at(-1), "subagents:workers", "the last completion removes the panel immediately");
  client.stop();
});
