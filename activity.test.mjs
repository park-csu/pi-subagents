import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityTracker, toolActivity, displayText, WorkerWidget, progressLine, compactLine, singleLine, workerTree, workerPreview } from "./activity.ts";

test("activity displays literal tool names without arguments or hardcoded mapping", () => {
  assert.equal(toolActivity("read", { path: "/repo/src/core.ts" }), "read");
  assert.equal(toolActivity("custom_future_tool", { secret: "SECRET" }), "custom_future_tool");
  assert.equal(toolActivity("bash", { command: "npm test --token=SECRET" }), "bash");
  assert.equal(toolActivity("web_fetch", { url: "https://user:SECRET@arxiv.org/html/foo?key=SECRET" }), "web_fetch");
  assert.ok(!displayText("\x1b[31mhello\nworld\u202e").includes("\x1b"));
});

test("parallel tool completion does not hide another active tool", () => {
  const tracker = new ActivityTracker();
  tracker.update({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a.ts" } });
  tracker.update({ type: "tool_execution_start", toolCallId: "b", toolName: "web_search" });
  assert.match(tracker.snapshot().activity, /\+1 tools/);
  tracker.update({ type: "tool_execution_end", toolCallId: "a" });
  assert.equal(tracker.snapshot().activity, "web_search");
  tracker.update({ type: "tool_execution_end", toolCallId: "b", isError: true });
  assert.equal(tracker.snapshot().activity, "web_search");
  tracker.update({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Check the contract first" } });
  assert.equal(tracker.snapshot().thinkingPreview, "Check the contract first");
  for (let i = 0; i < 20; i++) tracker.update({ type: "tool_execution_start", toolCallId: String(i), toolName: "read" });
  assert.equal(tracker.snapshot().thinkingPreview, "");
  assert.equal(tracker.snapshot().recent.length, 6);
});

test("last meaningful activity persists through idle turns and output generation", () => {
  const tracker = new ActivityTracker();
  tracker.update({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "a".repeat(2000) } });
  assert.equal(tracker.snapshot().thinkingPreview.length, 800);
  tracker.update({ type: "turn_start" });
  assert.equal(tracker.snapshot().thinkingPreview.length, 800);
  tracker.update({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
  tracker.update({ type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "Actual block" } });
  assert.equal(tracker.snapshot().thinkingPreview, "Actual block");
  tracker.update({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
  assert.equal(tracker.snapshot().thinkingPreview, "Actual block");
});

test("widget hides completed work immediately and detaches without late renders", async () => {
  const calls = [];
  let component;
  let rendered;
  const truncate = (text, width) => text.slice(0, width);
  const widget = new WorkerWidget({ tickMs: 5, settleMs: 10, truncate });
  const tui = { requestRender: () => { if (component) rendered = component.render(80); } };
  const ui = {
    setWidget: (key, factory) => {
      if (factory) {
        component = factory(tui);
        rendered = component.render(80);
      } else {
        component = undefined;
        rendered = undefined;
      }
      calls.push({ key, lines: rendered });
    },
  };
  widget.start(ui, { runId: "a", agent: "researcher", goal: "Find evidence", status: "running", activity: "Searching the web" });
  assert.equal(rendered.length, 2);
  assert.match(rendered[1], /Searching the web/);
  widget.finish({ runId: "a", agent: "researcher", goal: "Find evidence", status: "completed", activity: "Finished", elapsedMs: 1000 });
  assert.equal(rendered, undefined);
  assert.equal(widget.timer, undefined);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls.at(-1).lines, undefined);
  widget.dispose();
  const count = calls.length;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(calls.length, count);
  assert.match(progressLine({ agent: "a", elapsedMs: 65000 }), /1m 5s/);
});

test("Unicode tree connectors preserve ancestry and sibling continuations", () => {
  const item = (id, parent = "") => ({ runId: id, parentRunId: parent, agent: id, status: "running", activity: "read" });
  const lines = workerTree([item("root"), item("a", "root"), item("b", "root"), item("c", "a"), item("other")], { now: 0 });
  assert.match(lines[0], /^⠋ root/);
  assert.match(lines[1], /^├─ ⠋ a/);
  assert.match(lines[2], /^│  └─ ⠋ c/);
  assert.match(lines[3], /^└─ ⠋ b/);
  assert.match(lines[4], /^⠋ other/);
  assert.ok(!lines.join("\n").includes("delegated from"));
  assert.match(workerTree([{ agent: "legacy", status: "completed" }])[0], /^✓ legacy/);
});

test("finishing one worker neither clears siblings nor orphans active descendants", async () => {
  let rendered;
  const widget = new WorkerWidget({ tickMs: 5, settleMs: 10, truncate: (text, width) => text.slice(0, width) });
  let component;
  const tui = { requestRender: () => { if (component) rendered = component.render(80); } };
  const ui = {
    setWidget: (_key, factory) => {
      if (factory) {
        component = factory(tui);
        rendered = component.render(80);
      } else {
        component = undefined;
        rendered = undefined;
      }
    },
  };
  const a = { runId: "a", agent: "a", status: "running" };
  const b = { runId: "b", agent: "b", status: "running" };
  try {
    widget.start(ui, a);
    widget.start(ui, b);
    widget.update({ runId: "child", parentRunId: "a", agent: "child", status: "running" });
    widget.finish({ ...a, status: "completed" });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(rendered.length, 3);
    assert.ok(rendered.some(line => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] child/.test(line)));
    assert.ok(!rendered.some(line => /✓ a/.test(line)));
    widget.finish({ runId: "child", parentRunId: "a", agent: "child", status: "completed" });
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(rendered.length, 2);
    assert.match(rendered[1], /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] b/);
  } finally { widget.dispose(); }
});

test("relayed progress is bounded and cannot carry outputs or control fields", () => {
  const runId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const preview = workerPreview({ runId, agent: "researcher", output: "SECRET", goal: "g".repeat(5000),
    thinkingPreview: "t".repeat(5000), status: "running", usage: { cost: { total: Infinity } }, tools: ["bash"] });
  assert.equal(preview.goal.length, 200);
  assert.equal(preview.thinkingPreview.length, 800);
  assert.equal(preview.status, "running");
  assert.equal(workerPreview({ runId, status: "bogus" }), undefined);
  assert.equal(preview.usage.cost.total, 0);
  assert.equal(preview.output, undefined);
  assert.equal(preview.tools, undefined);
  assert.equal(workerPreview({ runId: "../bad" }), undefined);
});

test("collapsed rendering stays one line and prioritizes current activity", () => {
  const text = compactLine({ agent: "researcher", elapsedMs: 65000, turns: 3,
    thinkingPreview: "Compare primary evidence ".repeat(100), goal: "Not in collapsed view" });
  assert.match(text, /^researcher 1m5s 3t · Not in collapsed view · Thinking:/);
  assert.ok(text.includes("Not in collapsed view"));
  const component = singleLine(text, (value, width) => value.slice(0, width));
  for (const width of [0, 1, 20, 80]) {
    const lines = component.render(width);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].length <= width);
  }
});
