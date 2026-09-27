import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { realpathSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { getToolRenderers, styleToolDefinition } from "../ui-kit/tools.ts";

let root = process.env.PI_TEST_PACKAGE_ROOT;
if (!root) {
  root = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
  while (!existsSync(join(root, "package.json")) && dirname(root) !== root) root = dirname(root);
}
const requirePi = createRequire(join(root, "package.json"));
const piComponents = await import(pathToFileURL(join(root, "dist/index.js")));
piComponents.initTheme("dark", false);
const { KeybindingsManager } = await import(pathToFileURL(join(root, "dist/core/keybindings.js")));
const { visibleWidth } = requirePi("@earendil-works/pi-tui");
const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(root, "dist/core/extensions/loader.js")));

test("native /subagents overlay renders restored runs and Escape does not interrupt workers", async () => {
  const events = [];
  const bus = { on() { return () => {}; }, emit(name) { events.push(name); } };
  const runtime = createExtensionRuntime();
  const loaded = await loadExtensions([fileURLToPath(new URL("index.ts", import.meta.url))], process.cwd(), bus, runtime);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  let rawInput, overlay;
  const tui = { terminal: { rows: 24 }, requestRender() {} };
  const theme = { fg: (_color, text) => text };
  const runId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const ctx = { cwd: process.cwd(), mode: "tui", hasUI: true, isIdle: () => true, sessionManager: { getBranch: () => [
    { type: "custom", customType: "subagent-state", data: { runId, status: "completed", agent: "researcher",
      model: "fixture", thinking: "high", goal: "한국어 evidence", output: "Final report" } },
  ] }, ui: { theme,
    notify() {}, setWidget() {},
    onTerminalInput(handler) { rawInput = handler; return () => {}; },
    custom(factory) { return new Promise(resolve => { overlay = factory(tui, theme, new KeybindingsManager(), resolve); }); },
  } };
  try {
    for (const hook of extension.handlers.get("session_start")) await hook({}, ctx);
    const pending = extension.commands.get("subagents").handler("", ctx);
    assert.match(overlay.render(80).join("\n"), /researcher.*Completed/);
    overlay.handleInput("\r");
    await new Promise(resolve => setImmediate(resolve));
    for (const width of [20, 40, 80, 120]) {
      const lines = overlay.render(width);
      assert.ok(lines.every(line => visibleWidth(line) === width), "frame fills every cell, including Korean text and blank rows");
      assert.ok(lines[0].startsWith("╭") && lines.at(-1).endsWith("╯"));
      assert.equal(lines.length, 21, "frame stays within the overlay height");
    }
    overlay.handleInput("\x1b[F"); // End follows the recorded output and final report.
    assert.match(overlay.render(120).join("\n"), /Final report/);
    rawInput("\x1b");
    overlay.handleInput("\x1b");
    await pending;
    assert.ok(!events.includes("subagents:user-interrupt"));
    rawInput("\x1b");
    assert.ok(events.includes("subagents:user-interrupt"), "parent Escape retains its existing behavior");
  } finally {
    overlay?.dispose();
    for (const hook of extension.handlers.get("session_shutdown")) await hook({}, ctx);
  }
});

const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
  "@earendil-works/pi-tui": requirePi.resolve("@earendil-works/pi-tui"),
} });
const { createTranscriptRenderer } = await jiti.import("./transcript.ts");
const strip = text => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("our extensions publish their native renderers and the viewer reuses web and patch rendering", async () => {
  const listeners = new Map();
  const bus = {
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
      return () => listeners.get(name).delete(handler);
    },
    emit(name, data) { for (const handler of listeners.get(name) ?? []) handler(data); },
  };
  const paths = ["web", "apply-patch", "question", "visual-tools", "subagents", "ui-kit"]
    .map(name => fileURLToPath(new URL(`../${name}/index.ts`, import.meta.url)));
  const loaded = await loadExtensions(paths, process.cwd(), bus, createExtensionRuntime());
  assert.deepEqual(loaded.errors, []);
  const shared = getToolRenderers(bus);
  for (const extension of loaded.extensions) {
    for (const [name, tool] of extension.tools) {
      assert.ok(shared.has(name), `${name} must be exposed`);
      assert.equal(shared.get(name).renderCall, tool.definition.renderCall);
      assert.equal(shared.get(name).renderResult, tool.definition.renderResult);
      assert.equal(shared.get(name).execute, undefined);
    }
  }
  assert.ok(shared.has("web_search") && shared.has("apply_patch") && shared.has("question") && shared.has("write_svg"));
  const tui = { requestRender() {} };
  const renderer = createTranscriptRenderer(tui, process.cwd(), () => getToolRenderers(bus));
  for (const [name, args, result] of [
    ["web_search", { query: "render fixture" }, { content: [{ type: "text", text: "Search result" }],
      details: { resultCount: 1, provider: "exa", urls: ["https://example.com"], titles: ["Fixture source"] } }],
    ["apply_patch", { patch: "fixture" }, { content: [{ type: "text", text: "Patch fixture diagnostic" }] }],
  ]) {
    const log = { events: [
      { type: "tool_execution_start", toolCallId: name, toolName: name, args },
      { type: "tool_execution_end", toolCallId: name, toolName: name, result },
    ] };
    const actual = renderer.render({ runId: name }, log, 90, { expanded: true }).join("\n");
    const native = new piComponents.ToolExecutionComponent(name, name, args, { showImages: false }, shared.get(name), tui, process.cwd());
    native.markExecutionStarted(); native.setArgsComplete(); native.updateResult(result); native.setExpanded(true);
    assert.ok(actual.includes(native.render(90).join("\n")), `${name} must match its original renderer`);
    if (name === "web_search") assert.match(strip(actual), /Fixture source/);
  }
});

test("native transcript renders Markdown, matches tool results and expands real read output", () => {
  const renderer = createTranscriptRenderer({ requestRender() {} }, process.cwd());
  const message = { role: "assistant", content: [
    { type: "thinking", thinking: "Inspecting evidence" },
    { type: "text", text: "**Finding**\n\n```typescript\nconst answer: number = 42;\n```" },
    { type: "toolCall", id: "read-1", name: "read", arguments: { path: "example.ts" } },
  ], stopReason: "toolUse" };
  const result = { content: [{ type: "text", text: Array.from({ length: 40 }, (_, i) => `const value${i} = ${i};`).join("\n") }], isError: false };
  const log = { events: [
    { type: "message_end", message },
    { type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "example.ts" } },
    { type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result },
    { type: "message_end", message: { ...result, role: "toolResult", toolCallId: "read-1", toolName: "read" } },
  ] };
  const entry = { runId: "worker", goal: "Review **evidence**" };
  const collapsed = renderer.render(entry, log, 100).join("\n");
  const expanded = renderer.render(entry, log, 100, { expanded: true }).join("\n");
  assert.ok(expanded.includes("\x1b["), "native theme and code highlighting are applied");
  const nativeMessage = new piComponents.AssistantMessageComponent(message, false, piComponents.getMarkdownTheme());
  assert.ok(expanded.includes(nativeMessage.render(100).join("\n")), "Markdown uses the exact Pi message renderer");
  assert.ok(!strip(expanded).includes("**Finding**"));
  assert.match(strip(expanded), /const answer: number = 42/);
  assert.equal((strip(expanded).match(/example\.ts/g) ?? []).length, 1, "call and result share one component");
  assert.ok(expanded.split("\n").length > collapsed.split("\n").length);
  const hidden = renderer.render(entry, log, 100, { hideThinking: true }).join("\n");
  assert.ok(!strip(hidden).includes("Inspecting evidence"));
  const definition = styleToolDefinition(piComponents.createReadToolDefinition(process.cwd()));
  const native = new piComponents.ToolExecutionComponent("read", "read-1", { path: "example.ts" },
    { showImages: false }, definition, { requestRender() {} }, process.cwd());
  native.markExecutionStarted(); native.setArgsComplete(); native.updateResult(result); native.setExpanded(true);
  assert.ok(expanded.includes(native.render(100).join("\n")), "read tool uses Pi's renderer with shared title styling");
});

test("native transcript supports delta-only thinking and text streams without duplicate final messages", () => {
  const renderer = createTranscriptRenderer({ requestRender() {} }, process.cwd());
  const events = [
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Checking source" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Streamed finding" } },
  ];
  const entry = { runId: "worker", goal: "Review" };
  assert.match(strip(renderer.render(entry, { events }, 100).join("\n")), /Streamed finding/);
  const final = { events: [...events, { type: "message_end", message: { role: "assistant",
    content: [{ type: "text", text: "Final finding" }], stopReason: "stop" } }] };
  const output = strip(renderer.render(entry, final, 100).join("\n"));
  assert.equal((output.match(/Final finding/g) ?? []).length, 1);
  assert.ok(!output.includes("Streamed finding"));
});

test("handoff stays compact, renders one report, and preserves expandable JSON", () => {
  const renderer = createTranscriptRenderer({ requestRender() {} }, process.cwd());
  const report = '검증 완료: **한글 보고서** with "quotes" and\nnew lines.';
  const args = { report };
  const result = { content: [{ type: "text", text: "Report handed to parent for review." }], details: { finishTask: { report } } };
  const log = { events: [
    { type: "tool_execution_start", toolCallId: "finish", toolName: "finish_task", args },
    { type: "tool_execution_end", toolCallId: "finish", toolName: "finish_task", result },
  ] };
  const collapsed = strip(renderer.render({ runId: "worker" }, log, 76).join("\n"));
  assert.equal((collapsed.match(/한글 보고서/g) || []).length, 1);
  assert.match(collapsed, /✓ Report handed to parent/);
  assert.ok(!collapsed.includes('"report":'));
  const expanded = strip(renderer.render({ runId: "worker" }, log, 76, { expanded: true }).join("\n"));
  assert.match(expanded, /"report":/);
  assert.ok(expanded.includes('\\"quotes\\"'));
  const failed = { events: [log.events[0], { ...log.events[1], isError: true,
    result: { content: [{ type: "text", text: "Owned workers must settle first" }] } }] };
  const error = strip(renderer.render({ runId: "worker" }, failed, 76).join("\n"));
  assert.match(error, /Owned workers must settle first/);
  assert.ok(!error.includes("✓ Report handed"));
});

test("browser scrolling uses configured Pi actions, including disabled defaults and half pages", async () => {
  const { KeybindingsManager } = await import(pathToFileURL(join(root, "dist/core/keybindings.js")));
  const { createWorkerBrowser } = await import("./browser.ts");
  const { matchesKey } = requirePi("@earendil-works/pi-tui");
  const keys = new KeybindingsManager({
    "tui.altScreen.pageDown": ["ctrl+n", "alt+n"],
    "tui.altScreen.pageUp": [],
    "tui.altScreen.halfPageDown": "ctrl+d",
    "tui.altScreen.halfPageUp": "ctrl+u",
    "tui.select.down": "j",
    "tui.editor.cursorLineEnd": "g",
    "tui.editor.cursorLineStart": "t",
  });
  const view = createWorkerBrowser({
    list: () => [{ runId: "worker", agent: "worker", status: "completed" }],
    readLog: async () => "", tui: { terminal: { rows: 20 }, requestRender() {} },
    theme: {}, done() {}, matchesKey, keybindings: keys,
    truncate: (text, width) => text.slice(0, width), wrap: text => [text],
    transcript: { render: () => Array.from({ length: 100 }, (_, i) => `Line ${i}`) },
  });
  const screen = () => view.render(180).join("\n");
  const position = () => Number(screen().match(/ · (\d+)–/)[1]);
  try {
    screen(); view.handleInput("\r");
    assert.equal(position(), 1);
    view.handleInput("\x1b[6~"); // Replaced Page Down binding.
    assert.equal(position(), 1);
    view.handleInput("\x0e");
    assert.equal(position(), 13);
    view.handleInput("\x1bn");
    assert.equal(position(), 25);
    view.handleInput("\x1b[5~"); // Disabled Page Up binding.
    assert.equal(position(), 25);
    view.handleInput("\x15"); assert.equal(position(), 19);
    view.handleInput("\x04"); assert.equal(position(), 25);
    view.handleInput("j"); assert.equal(position(), 26);
    view.handleInput("\x1b[B"); assert.equal(position(), 26);
    view.handleInput("g"); assert.equal(position(), 89);
    assert.match(screen(), /Following/);
    view.handleInput("t"); assert.equal(position(), 1);
    assert.match(screen(), /unbound\/ctrl\+n\/alt\+n scroll · g follow/);
  } finally { view.dispose(); }
});
