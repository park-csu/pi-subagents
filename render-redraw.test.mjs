import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { realpathSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkerStates } from "./state.ts";
import { WorkerWidget, workerTree } from "./activity.ts";
import { createPanelHost } from "../ui-kit/core.ts";

// Use the installed renderer, not a fake requestRender implementation.
let root = process.env.PI_TEST_PACKAGE_ROOT;
if (!root) {
  root = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
  while (!existsSync(join(root, "package.json")) && dirname(root) !== root) root = dirname(root);
}
const requirePi = createRequire(join(root, "package.json"));
const { truncateToWidth } = requirePi("@earendil-works/pi-tui");
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-tui": requirePi.resolve("@earendil-works/pi-tui") },
});
const { renderDelegateResult } = await jiti.import("./render.ts");
const { TuiMainScreen } = await import(pathToFileURL(
  join(dirname(requirePi.resolve("@earendil-works/pi-tui")), "tui-main-screen.js"),
));
const theme = { fg: (_color, text) => text };

for (const expanded of [false, true]) {
  test(`offscreen delegate history does not clear on clock/key repaint (expanded=${expanded})`, () => {
    const realNow = Date.now;
    let now = 100_000;
    Date.now = () => now;
    try {
      const child = { runId: "child", parentRunId: "root", agent: "child",
        status: "running", startedAt: 2000, elapsedMs: 98000 };
      const info = { runId: "root", agent: "parent", status: "running",
        startedAt: 1000, elapsedMs: 99000, descendants: [child] };
      const states = new WorkerStates();
      const card = renderDelegateResult({ details: info }, { expanded, isPartial: false },
        theme, { invalidate() {} }, states);
      let output = "";
      let input = "";
      const terminal = { columns: 116, rows: 55, write: data => { output += data; },
        hideCursor() {}, showCursor() {} };
      const tui = new TuiMainScreen(terminal, false);
      tui.addChild(card);
      tui.addChild({ render: () => [
        ...Array.from({ length: 90 }, (_, i) => `History ${i}`), `Input: ${input}`,
      ], invalidate() {} });
      const before = card.render(116);
      tui.doRender();
      for (let i = 0; i < 5; i++) {
        output = "";
        now += 1000;
        input += "a";
        tui.doRender();
        assert.deepEqual(card.render(116), before);
        assert.ok(!output.includes("\x1b[2J"), "keypress must not clear the screen");
        assert.ok(!output.includes("\x1b[3J"), "keypress must not clear scrollback");
        assert.ok(output.includes(`Input: ${input}`), "real input diff still renders");
      }
      // The panel still advances its clock; terminal lifecycle updates remain visible.
      assert.notDeepEqual(workerTree([info], { now }), workerTree([info], { now: now + 1000 }));
      states.update({ ...info, status: "completed", elapsedMs: 105000 });
      assert.match(card.render(116).join("\n"), /✓/);
    } finally {
      Date.now = realNow;
    }
  });
}

for (const expanded of [false, true]) {
  test(`offscreen progress stays in ui-kit without replaying history (expanded=${expanded})`, () => {
    let now = 100_000;
    let tick;
    let redraws = 0;
    const controller = createPanelHost({
      now: () => now,
      requestRender() {},
      truncateToWidth,
      timers: {
        setInterval(callback) { tick = callback; return callback; },
        clearInterval() { tick = undefined; },
      },
    });
    const widget = new WorkerWidget({ truncate: truncateToWidth });
    widget.attachHost(controller.host);
    // An unrelated provider shares the same host (OM uses this protocol).
    controller.host.upsert({ id: "other", order: 100, render: () => ["Other panel"] });
    const info = { runId: "root", agent: "parent", status: "running", goal: "Original task",
      startedAt: 1000, elapsedMs: 99000, activity: "Starting" };
    const child = { ...info, runId: "child", parentRunId: "root", agent: "child" };
    const states = new WorkerStates();
    states.update(info);
    states.update(child);
    widget.update(info);
    widget.update(child);
    const original = { ...info, descendants: [child] };
    const context = { invalidate() { redraws++; } };
    const card = renderDelegateResult({ details: original }, { expanded, isPartial: false },
      theme, context, states);
    let output = "";
    const tui = new TuiMainScreen({
      columns: 77, rows: 49, write(data) { output += data; }, hideCursor() {}, showCursor() {},
    }, false);
    tui.addChild(card);
    tui.addChild({ render: () => Array.from({ length: 3000 }, (_, i) => `History ${i}`), invalidate() {} });
    tui.addChild({ render: width => controller.render(width, theme), invalidate() {} });
    try {
      const before = card.render(77);
      tui.doRender();
      for (let i = 1; i <= 30; i++) {
        output = "";
        now += 1000;
        for (const worker of [info, child]) {
          const progress = { ...worker, elapsedMs: now - worker.startedAt, turns: i,
            activity: `bash ${i}`, thinkingPreview: `Investigating ${i}`,
            recent: [`read ${i}`], observation: { state: "current", lastEventAt: now },
            usage: { cost: { total: i / 10 } } };
          states.update(progress);
          widget.update(progress);
        }
        tick();
        tui.doRender();
        assert.ok(!output.includes("\x1b[2J"), "progress must not clear the screen");
        assert.ok(!output.includes("\x1b[3J"), "progress must not clear scrollback");
        assert.equal(redraws, 0, "progress must not invalidate transcript cards");
        assert.deepEqual(card.render(77), before);
        assert.deepEqual(renderDelegateResult({ details: original }, { expanded, isPartial: false },
          theme, context, states).render(77), before, "rebuilding the card must not expose live state");
        assert.ok(!output.includes("History 0"), "progress must not replay history");
        assert.match(controller.render(77, theme).join("\n"), new RegExp(`Investigating ${i}`));
        assert.match(controller.render(77, theme).join("\n"), /Other panel/);
      }
      for (const status of ["paused", "running", "completed", "failed", "cancelled"]) {
        const previous = card.render(77);
        states.update({ ...child, status, output: "child report" });
        states.update({ ...info, status, output: "final report", runDir: "/tmp/result" });
        assert.equal(states.tree(original).status, status);
        assert.equal(states.tree(original).descendants[0].status, status);
        assert.notDeepEqual(card.render(77), previous, "lifecycle changes remain visible");
      }
      const restored = renderDelegateResult({ details: original }, { expanded: true, isPartial: false },
        theme, context, states).render(77).join("\n");
      assert.match(restored, /final report/);
      assert.match(restored, /\/tmp\/result/);
    } finally {
      widget.dispose();
      controller.stop();
    }
  });
}
