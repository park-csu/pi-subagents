import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerBrowser } from "./browser.ts";
import { createLogReader, formatLogEvents } from "./logs.ts";
import { WorkerWidget, workerPanelLines } from "./activity.ts";

const entry = (id, status = "running") => ({ runId: id, agent: id, status, activity: "read", elapsedMs: 1000 });

test("live panel hides completion while retaining full worker history", () => {
  const widget = new WorkerWidget();
  try {
    for (let i = 0; i < 20; i++) widget.finish(entry(`done-${i}`, "completed"));
    widget.update({ ...entry("active"), thinkingPreview: "Checking evidence" });
    widget.update(entry("paused", "paused"));
    widget.prune(Date.now() + 100000);
    const lines = widget.renderPanel(120);
    assert.equal(widget.workers.size, 22);
    assert.equal(widget.settlementTimer, undefined);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /1 running/);
    assert.match(lines[1], /active.*Thinking: Checking evidence/);
    assert.doesNotMatch(lines.join("\n"), /completed|done-|paused|more/);
    for (const width of [1, 20, 80]) assert.ok(widget.renderPanel(width).every(line => line.length <= width));
  } finally { widget.dispose(); }
});

test("live panel counts and caps only running non-restored workers", () => {
  const inactive = ["completed", "paused", "failed", "cancelled"].map(status => entry(status, status));
  inactive.push({ ...entry("restored"), restored: true });
  assert.deepEqual(workerPanelLines(inactive), []);
  const active = Array.from({ length: 6 }, (_, i) => entry(`live-${i}`));
  const lines = workerPanelLines([...inactive, ...active]);
  assert.equal(lines.length, 6);
  assert.equal(lines[0], "Subagents · 6 running");
  assert.match(lines.at(-1), /\+2 more/);
  assert.doesNotMatch(lines.join("\n"), /completed|paused|failed|cancelled|restored/);
});

test("browser retains selected worker across updates, scrolls, and closes without control calls", async () => {
  let entries = [entry("first"), entry("second")];
  let closed = 0, redraws = 0;
  const view = createWorkerBrowser({ list: () => entries,
    readLog: async () => Array.from({ length: 50 }, (_, i) => `Log ${i}`).join("\n"),
    tui: { terminal: { rows: 20 }, requestRender() { redraws++; } }, theme: {}, done() { closed++; },
    matchesKey: (data, key) => data === key, truncate: (text, width) => text.slice(0, width), wrap: text => [text] });
  try {
    view.render(120);
    view.handleInput("down");
    entries = [entry("new"), ...entries];
    assert.match(view.render(120).join("\n"), /› second/);
    view.handleInput("enter");
    await new Promise(resolve => setImmediate(resolve));
    assert.match(view.render(120)[0], /second/);
    view.handleInput("end");
    assert.match(view.render(120).join("\n"), /Log 49/);
    view.handleInput("home");
    assert.match(view.render(120).join("\n"), /Task/);
    assert.ok(!view.render(120).join("\n").includes("Log 49"));
    view.handleInput("left");
    assert.match(view.render(120).join("\n"), /› second/);
    view.handleInput("escape");
    assert.equal(closed, 1);
    assert.ok(redraws > 0);
  } finally { view.dispose(); }
});

test("closing browser ignores an in-flight log read", async () => {
  let resolveLog;
  let renders = 0;
  const view = createWorkerBrowser({ list: () => [entry("worker")], readLog: () => new Promise(resolve => { resolveLog = resolve; }),
    tui: { requestRender() { renders++; } }, theme: {}, done() {}, matchesKey: (data, key) => data === key,
    truncate: (text, width) => text.slice(0, width), wrap: text => [text] });
  view.render(80);
  view.handleInput("enter");
  view.handleInput("escape");
  const before = renders;
  resolveLog("Late log");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(renders, before);
});

test("detail controls target the selected run, retain failed drafts, and Escape only cancels input", async () => {
  const calls = [];
  let fail = true, closed = 0;
  const input = { value: "", focused: false, setValue(value) { this.value = value; }, render: () => ["Draft"],
    handleInput(data) { if (data === "enter") this.onSubmit(this.value); else this.value += data; } };
  const view = createWorkerBrowser({ list: () => [{ ...entry("worker"), canMessage: true, canPause: true }],
    readLog: async () => "Activity", tui: { requestRender() {} }, theme: {}, done() { closed++; },
    matchesKey: (data, key) => data === key, truncate: (text, width) => text.slice(0, width), wrap: text => [text], input,
    control: async (...args) => { calls.push(args); if (fail) throw Error("No connection"); return { runId: "worker" }; } });
  try {
    view.render(100); view.handleInput("enter"); view.handleInput("m");
    view.handleInput("Hello"); view.handleInput("enter");
    await new Promise(resolve => setImmediate(resolve));
    assert.match(view.render(100).join("\n"), /No connection/);
    assert.equal(input.value, "Hello");
    view.handleInput("escape");
    assert.equal(closed, 0);
    fail = false;
    view.handleInput("m"); view.handleInput("enter");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(input.value, "");
    assert.deepEqual(calls[1], ["worker", "message", "Hello"]);
    view.handleInput("p");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls[2], ["worker", "pause", undefined]);
    assert.match(view.render(100).join("\n"), /Pause requested/);
    view.handleInput("escape"); assert.equal(closed, 1);
  } finally { view.dispose(); }
});

test("browser forwards native transcript display shortcuts", () => {
  let options;
  const view = createWorkerBrowser({ list: () => [entry("worker")], readLog: async () => ({ events: [] }),
    tui: { requestRender() {} }, theme: {}, done() {}, matchesKey: (data, key) => data === key,
    truncate: (text, width) => text.slice(0, width), wrap: text => [text],
    transcript: { render(_entry, _log, _width, value) { options = value; return ["Native content"]; } } });
  try {
    view.render(100);
    view.handleInput("enter");
    view.handleInput("ctrl+o");
    view.handleInput("ctrl+t");
    assert.match(view.render(100).join("\n"), /Native content/);
    assert.deepEqual(options, { expanded: true, hideThinking: true });
  } finally { view.dispose(); }
});

test("log reader tolerates partial records, refreshes appended events and rejects escaped paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-log-ui-"));
  try {
    const runs = join(root, "runs"), run = join(runs, "worker");
    await mkdir(run, { recursive: true });
    const file = join(run, "events.jsonl");
    const read = createLogReader(runs);
    const first = JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "source.ts" } });
    await writeFile(file, first + '\n{"type":"worker_task_done","report":');
    assert.match(await read(run), /source.ts/);
    const readStructured = createLogReader(runs, { structured: true });
    const snapshot = await readStructured(run);
    assert.deepEqual(snapshot.events, [JSON.parse(first)]);
    assert.equal(await readStructured(run), snapshot, "unchanged logs reuse the render snapshot");
    await appendFile(file, '"Finished"}\n');
    assert.match(await read(run), /Report\nFinished/);
    assert.equal((await readStructured(run)).events.at(-1).report, "Finished");
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "events.jsonl"), first);
    await symlink(outside, join(runs, "link"));
    assert.match(await read(join(runs, "link")), /outside worker storage/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("log formatting bounds output and strips terminal control sequences", () => {
  const event = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "\x1b[31mEvidence\x1b[0m" }] } });
  const result = formatLogEvents(Array(100).fill(event).join("\n"));
  assert.ok(!result.includes("\x1b"));
  assert.match(result, /Showing recent recorded activity/);
  assert.ok(result.length < 33000);
});
