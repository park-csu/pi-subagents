import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { realpathSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { resumePrompt } from "./state.ts";
import { WorkerStates } from "./state.ts";
import { workerPreview, workerTree } from "./activity.ts";

let root = process.env.PI_TEST_PACKAGE_ROOT;
if (!root) {
  root = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
  while (!existsSync(join(root, "package.json")) && dirname(root) !== root) root = dirname(root);
}
const requirePi = createRequire(join(root, "package.json"));
const { visibleWidth } = requirePi("@earendil-works/pi-tui");
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-tui": requirePi.resolve("@earendil-works/pi-tui") },
});
const { renderSubagentCompletion, renderDelegateResult, renderDelegateMessageCall, renderDelegateCall } = await jiti.import("./render.ts");

const theme = {
  fg: (_color, text) => text,
  bg: (color, text) => `\x1b[${color === "toolErrorBg" ? 41 : color === "toolPendingBg" ? 43 : 42}m${text}\x1b[49m`,
  bold: text => `\x1b[1m${text}\x1b[22m`,
  italic: text => `\x1b[3m${text}\x1b[23m`,
  underline: text => `\x1b[4m${text}\x1b[24m`,
  strikethrough: text => `\x1b[9m${text}\x1b[29m`,
};
const stripAnsi = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("delegate contract headers match completion styling for every worker status", () => {
  const colors = { muted: 90, accent: 36, error: 31, toolTitle: 37, dim: 90 };
  const styledTheme = { ...theme, fg: (color, text) => `\x1b[${colors[color] ?? 39}m${text}\x1b[39m` };
  const contract = { objective: "Review UI", scope: { read: [], write: [] },
    plan: ["Review"], acceptance: ["Report findings"] };
  for (const [status, icon, color] of [
    ["running", "◐", "accent"], ["paused", "Ⅱ", "muted"], ["completed", "✓", "muted"],
    ["failed", "✗", "error"], ["cancelled", "✗", "muted"],
  ]) {
    const prefix = styledTheme.fg(color, `${icon} `) +
      styledTheme.fg("toolTitle", styledTheme.bold("ui-check (scout)"));
    const message = completion("Report", { name: "ui-check", status });
    message.details.role = "scout";
    assert.ok(renderSubagentCompletion(message, {}, styledTheme).render(120).join("\n")
      .includes(prefix + styledTheme.fg("dim", ` · ${status}`)));
    for (const mode of ["sync", "async"]) {
      for (const expanded of [false, true]) {
        const info = { runId: "styled-contract", agent: "ui-check", role: "scout", status, mode, contract };
        const before = structuredClone(info);
        const card = renderDelegateResult({ details: info }, { expanded }, styledTheme, {}, new WorkerStates());
        const output = card.render(120).join("\n");
        assert.ok(output.includes(prefix + styledTheme.fg("dim", ` · ${mode} · ${status}`)),
          `${status}/${mode}/${expanded}: delegate header should match completion styles`);
        for (const width of [1, 8, 30]) {
          assert.ok(card.render(width).every(line => visibleWidth(line) <= width));
        }
        assert.deepEqual(info, before);
      }
    }
  }
});

test("delegate report is separated from the contract by one blank row", () => {
  const info = {
    runId: "report-spacing", agent: "ui-check", role: "scout", status: "completed",
    contract: {
      objective: "Review UI", scope: { read: [], write: [] },
      plan: ["Read the file"], acceptance: ["Report findings"],
    },
    output: "First paragraph.\n\nSecond paragraph.",
  };
  const before = structuredClone(info);
  const card = renderDelegateResult({ details: info }, { expanded: true }, theme, {}, new WorkerStates());
  for (const width of [40, 120]) {
    const rows = card.render(width).map(stripAnsi);
    const heading = rows.findIndex(row => row.includes("Worker report"));
    assert.ok(heading > 1);
    assert.equal(rows[heading - 1].trim(), "");
    assert.match(rows[heading - 2], /Report findings/);
    assert.match(rows.join("\n"), /First paragraph\.\s*\n\s*\n\s*Second paragraph\./);
  }
  assert.deepEqual(info, before);
});

test("delegate call headers use bold titles and dim modes and refresh theme colors", () => {
  let titleColor = 37;
  const styledTheme = {
    ...theme,
    fg: (color, text) => `\x1b[${color === "toolTitle" ? titleColor : color === "dim" ? 90 : 39}m${text}\x1b[39m`,
  };
  const task = { objective: "Review", scope: { read: [], write: [] }, plan: ["Read"], acceptance: ["Report"] };
  for (const mode of ["sync", "async"]) {
    const card = renderDelegateCall({ agent: "scout", mode, task }, styledTheme, {});
    const expected = () => styledTheme.fg("toolTitle", styledTheme.bold("delegate scout")) +
      styledTheme.fg("dim", ` · ${mode}`);
    assert.ok(card.render(100).join("\n").includes(expected()));
    titleColor = titleColor === 37 ? 35 : 37;
    card.invalidate();
    assert.ok(card.render(100).join("\n").includes(expected()));
  }
});

test("delegate displays nickname and role in collapsed, expanded, and relayed rows", () => {
  for (const role of ["implementer", "scout", "researcher"]) {
    const info = {
      runId: "11111111-1111-4111-8111-111111111111",
      agent: "auth-fix", role, status: "running", goal: "Fix auth",
    };
    for (const expanded of [false, true]) {
      const output = renderDelegateResult({ details: info }, { expanded }, theme,
        { args: { agent: role } }, new WorkerStates()).render(120).join("\n");
      assert.ok(output.includes(`auth-fix (${role})`));
    }
    assert.ok(workerTree([workerPreview(info)]).join("\n").includes(`auth-fix (${role})`));
  }
});

test("historical delegate results recover role from call arguments without mutating details", () => {
  const details = { agent: "auth-fix", status: "completed" };
  const output = renderDelegateResult({ details }, { expanded: false }, theme,
    { args: { agent: "scout" } }, new WorkerStates()).render(100).join("\n");
  assert.match(output, /auth-fix \(scout\)/);
  assert.equal(details.role, undefined);
});

test("delegate_message shows recipient and ten message rows without modifying sent text", () => {
  const args = { name: "auth-fix", message: Array.from({ length: 12 }, (_, i) => `message ${i + 1}`).join("\n") };
  const before = structuredClone(args);
  const output = renderDelegateMessageCall(args, theme).render(100).join("\n");
  assert.match(output, /delegate_message → auth-fix/);
  assert.match(output, /message 10/);
  assert.doesNotMatch(output, /message 11/);
  assert.match(output, /2 more message rows omitted/);
  assert.deepEqual(args, before);
});

test("delegate_message caps wrapped rows, sanitizes controls, and tolerates partial arguments", () => {
  for (const width of [1, 7, 24, 80]) {
    const args = { name: "auth-fix", message: "\x1b[31m" + "日本語ROW".repeat(400) };
    const lines = renderDelegateMessageCall(args, theme).render(width);
    const titleLines = renderDelegateMessageCall({ name: args.name }, theme).render(width);
    assert.ok(lines.length <= titleLines.length + 11);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.doesNotMatch(lines.join("\n"), /\x1b\[31m/);
  }
  assert.doesNotThrow(() => renderDelegateMessageCall({}, theme).render(80));
  assert.deepEqual(renderDelegateMessageCall({}, theme).render(0), []);
});

function completion(output, overrides = {}) {
  const runId = overrides.runId ?? "11111111-1111-4111-8111-111111111111";
  const record = {
    runId,
    name: overrides.name ?? "researcher",
    status: overrides.status ?? "completed",
    output,
    runDir: overrides.runDir ?? "/tmp/subagent-runs/old",
    ...(overrides.error === undefined ? {} : { error: overrides.error }),
  };
  return {
    customType: "subagent-completion",
    content: resumePrompt(`Worker ${record.name}: ${record.status}. Completion is not approval.`, [record]),
    display: true,
    details: {
      runId,
      name: record.name,
      status: record.status,
      runDir: record.runDir,
      usage: { totalTokens: 7 },
    },
  };
}

test("completion renderer hides model-visible JSON and previews at most ten report lines", () => {
  const message = completion(Array.from({ length: 12 }, (_, i) => `report line ${i + 1}`).join("\n"));
  const rendered = renderSubagentCompletion(message, { expanded: false, outputPad: 0 }, theme)
    .render(80).join("\n");
  const plain = stripAnsi(rendered);

  assert.match(plain, /researcher/);
  assert.match(plain, /✓ researcher · completed/);
  assert.match(plain, /report line 10/);
  assert.doesNotMatch(plain, /report line 11/);
  assert.match(plain, /2 more report rows omitted; expand to view/);
  assert.doesNotMatch(plain, /"runId"/);
  assert.doesNotMatch(plain, /"output"/);
  assert.doesNotMatch(plain, /Artifacts: \/tmp\/subagent-runs\/old/);
});

test("completion renderer wraps safely at narrow terminal widths", () => {
  const message = completion("a".repeat(300) + "\n日本語の長いレポート");
  for (const width of [1, 7, 24, 80]) {
    const lines = renderSubagentCompletion(message, { expanded: false, outputPad: 2 }, theme).render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `line exceeds width ${width}`);
  }
});

test("collapsed preview caps wrapped rows for a long single-line report", () => {
  const message = completion("ROW".repeat(300));
  const lines = renderSubagentCompletion(message, { expanded: false, outputPad: 0 }, theme).render(24);
  const reportRows = lines.filter(line => line.includes("ROW"));

  assert.equal(reportRows.length, 10);
  assert.match(stripAnsi(lines.join(" ").replace(/\s+/g, " ")), /report rows\s+omitted; expand to\s+view/);
  assert.ok(lines.every(line => visibleWidth(line) <= 24));
});

test("completion renderer uses native card structure and Markdown body styling", () => {
  const message = completion("## Verdict\n\n- **PASS** — no blocking defects\n\nSee `result.json`.");
  const rendered = renderSubagentCompletion(message, { expanded: true, outputPad: 0 }, theme)
    .render(80).join("\n");
  const plain = stripAnsi(rendered);

  assert.match(plain, /researcher/);
  assert.match(plain, /✓ researcher · completed/);
  assert.match(plain, /Verdict/);
  assert.match(plain, /PASS/);
  assert.match(plain, /result\.json/);
  assert.doesNotMatch(plain, /## Verdict/);
  assert.doesNotMatch(plain, /\*\*PASS\*\*/);
  assert.match(plain, /Artifacts: \/tmp\/subagent-runs\/old/);
  assert.ok(rendered.includes("\x1b[42m"), "completion should use a themed card background");
  assert.ok(rendered.includes("\x1b[1m"), "completion title should be bold");
});

test("expanded completion renders the immutable report, without later resumed output", () => {
  const old = completion("OLD_REPORT\nsecond line");
  const later = completion("LATER_RESUMED_REPORT", {
    runId: "22222222-2222-4222-8222-222222222222",
    name: old.details.name,
    runDir: "/tmp/subagent-runs/new",
  });
  const renderedOld = renderSubagentCompletion(old, { expanded: true, outputPad: 0 }, theme)
    .render(80).join("\n");
  const renderedLater = renderSubagentCompletion(later, { expanded: true, outputPad: 0 }, theme)
    .render(80).join("\n");

  assert.match(renderedOld, /OLD_REPORT/);
  assert.match(renderedOld, /second line/);
  assert.doesNotMatch(renderedOld, /LATER_RESUMED_REPORT/);
  assert.match(renderedOld, /Artifacts: \/tmp\/subagent-runs\/old/);
  assert.match(renderedLater, /LATER_RESUMED_REPORT/);
});

test("failed completion shows a sanitized error when output is absent", () => {
  const message = completion(undefined, {
    status: "failed",
    error: "runner failed:\x1b[31m bad\nnext",
  });
  const rendered = renderSubagentCompletion(message, { expanded: false, outputPad: 0 }, theme)
    .render(80).join("\n");

  assert.match(stripAnsi(rendered), /✗ researcher · failed/);
  assert.match(rendered, /Error: runner failed: bad next/);
  assert.doesNotMatch(rendered, /\(no report available\)/);
  assert.doesNotMatch(rendered, /\x1b\[31m/);
  assert.ok(rendered.includes("\x1b[41m"), "failed completion should use the themed error background");
});

test("renderer leaves model-visible content and completion metadata unchanged", () => {
  const message = completion("report");
  const before = structuredClone({ content: message.content, details: message.details });
  renderSubagentCompletion(message, { expanded: false, outputPad: 0 }, theme).render(80);
  assert.deepEqual({ content: message.content, details: message.details }, before);
});

test("malformed historical payload degrades without rendering raw JSON", () => {
  const message = {
    customType: "subagent-completion",
    content: "Worker researcher completed: {not valid completion JSON}",
    display: true,
    details: {
      runId: "33333333-3333-4333-8333-333333333333",
      name: "researcher",
      status: "failed",
      runDir: "/tmp/subagent-runs/broken",
      usage: { totalTokens: 1 },
    },
  };
  const rendered = renderSubagentCompletion(message, { expanded: false, outputPad: 0 }, theme)
    .render(80).join("\n");

  assert.match(stripAnsi(rendered), /✗ researcher · failed/);
  assert.match(stripAnsi(rendered), /No report available/);
  assert.doesNotMatch(rendered, /not valid completion JSON/);
  assert.doesNotMatch(stripAnsi(rendered), /Artifacts: \/tmp\/subagent-runs\/broken/);
});


test("JSON execution contracts render as Markdown cards, including narrow and expanded views", () => {
  const task = { objective: "Repair **authentication**", scope: { read: ["src/auth.ts"], write: ["src/auth.ts"] },
    plan: ["Inspect expiry", "Run tests"], acceptance: ["Expired tokens rejected"], context: "Keep public API" };
  const args = { agent: "implementer", task, mode: "async", parallel_work: "Inspect unrelated UI copy" };
  const before = JSON.stringify(args);
  const call = renderDelegateCall(args, theme, { executionStarted: false });
  const rows = call.render(90).map(stripAnsi).join("\n");
  assert.match(rows, /Write scope/);
  assert.match(rows, /Acceptance/);
  assert.doesNotMatch(rows, /"objective"|\*\*authentication\*\*/);
  assert.match(renderDelegateCall({ ...args, mode: undefined }, theme, {}).render(90).join("\n"), /sync/);
  const info = { runId: "contract-run", agent: "impl", role: "implementer", status: "completed", mode: "async",
    contract: task, parallelWork: args.parallel_work, output: "Verified **tests**", runDir: "/tmp/contract-run" };
  const card = renderDelegateResult({ details: info }, { expanded: true, isPartial: false }, theme, {}, new WorkerStates());
  const expanded = card.render(100).map(stripAnsi).join("\n");
  assert.match(expanded, /Plan/);
  assert.match(expanded, /Inspect unrelated UI copy/);
  assert.match(expanded, /pending parent verification/);
  for (const width of [1, 8, 30]) assert.ok(card.render(width).every(line => visibleWidth(line) <= width));
  assert.equal(JSON.stringify(args), before);
});
