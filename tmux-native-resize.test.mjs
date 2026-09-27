import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { startWorker } from "./core.ts";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const available = process.platform === "linux" && spawnSync("tmux", ["-V"]).status === 0;

test("tmux-owned workers: native resize, 3x2 live TUI frames, control and cleanup", {
  skip: !available, timeout: 30000,
}, async () => {
  let root = process.env.PI_TEST_PACKAGE_ROOT;
  if (!root) {
    root = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
    while (!existsSync(join(root, "package.json"))) root = dirname(root);
  }
  const tuiDir = dirname(createRequire(join(root, "package.json")).resolve("@earendil-works/pi-tui"));
  const pool = await mkdtemp(join(tmpdir(), "pi-native-resize-"));
  const args = ["-L", `pi-native-resize-${randomUUID()}`, "-f", "/dev/null"];
  const cmd = (...rest) => execFileSync("tmux", [...args, ...rest], {
    encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const saved = { ...process.env };
  const workers = [];
  const snapshots = new Map();
  const script = `
    import {writeSync} from "node:fs";
    import {Socket} from "node:net";
    import {TuiMainScreen} from ${JSON.stringify(pathToFileURL(join(tuiDir, "tui-main-screen.js")).href)};
    import {ProcessTerminal} from ${JSON.stringify(pathToFileURL(join(tuiDir, "terminal.js")).href)};
    import {terminalResizeWidget} from ${JSON.stringify(new URL("./tmux-redraw.ts", import.meta.url).href)};
    const emit = event => writeSync(3, JSON.stringify(event) + "\\n");
    const tui = new TuiMainScreen(new ProcessTerminal(), false);
    const resizeWidget = terminalResizeWidget(tui);
    let tick = 0;
    let signals = 0;
    process.on("SIGWINCH", () => signals++);
    let frozen = false;
    tui.addChild({invalidate() {}, render(width) {
      return [...Array.from({length: 80}, (_, i) => ("History " + i).slice(0, width)),
        ("Elapsed " + tick).slice(0, width),
        ("WORKER " + process.env.PI_SUBAGENT_RUN_ID).slice(0, width),
        "-".repeat(width)];
    }});
    tui.start();
    const render = () => {
      if (!frozen) tick++;
      tui.renderNow();
      emit({type: "worker_progress", info: {pid: process.pid, tick,
        signals, redraws: tui.fullRedrawCount, width: process.stdout.columns, height: process.stdout.rows}});
    };
    const timer = setInterval(render, 20);
    const control = new Socket({fd: 4, readable: true, writable: false});
    let buffer = "";
    control.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line === "interrupt") {emit({type: "worker_paused"}); continue;}
        const request = JSON.parse(line);
        if (request.prompt === "freeze") {frozen = true; render();}
        if (request.prompt === "redraw") {tui.renderNow(true); render();}
        if (request.prompt === "finish") {
          clearInterval(timer); resizeWidget.dispose(); tui.stop();
          emit({type: "worker_task_done", report: "native resize verified"});
          process.exit(0);
        }
      }
    });
    emit({type: "worker_ready"});
    render();
  `;
  const waitFor = async (condition, description, timeout = 2000) => {
    const until = Date.now() + timeout;
    while (!condition() && Date.now() < until) await delay(10);
    assert.ok(condition(), description);
  };
  try {
    const main = cmd("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "fixture",
      "-x", "233", "-y", "56", "sleep 60");
    cmd("set-hook", "-w", "-t", main, "window-layout-changed[1]", "set-option -w @user_resize_hook yes");
    process.env.TMUX = cmd("display-message", "-p", "-t", main, "#{socket_path},#{pid},0");
    process.env.TMUX_PANE = main;
    delete process.env.PI_SUBAGENT_TMUX_MAIN;
    const start = async (runId, parentRunId = "") => {
      const worker = startWorker({
        agent: { name: "fixture", model: "fixture/model", thinking: "low",
          tools: [], can_delegate: false, systemPrompt: "Fixture" },
        task: "offline TUI fixture", cwd: pool, runsDir: pool, pool,
        extensionPath: "/unused", useTmux: true, runId, parentRunId,
        depth: parentRunId ? 1 : 0, waitForSession: true,
        command: process.execPath, prefix: ["--input-type=module", "-e", script, "--"],
        onDescendant: info => snapshots.set(runId, info),
      });
      workers.push({ worker, runId });
      await worker.ready;
      await waitFor(() => snapshots.has(runId), "worker rendered");
      const pid = snapshots.get(runId).pid;
      const [group, terminalGroup] = execFileSync("ps", ["-o", "pgid=,tpgid=", "-p", String(pid)],
        { encoding: "utf8" }).trim().split(/\s+/);
      assert.equal(group, terminalGroup, "worker must receive native terminal signals, not a polling proxy");
      return worker;
    };
    const geometry = () => cmd("list-panes", "-t", main, "-F",
      "#{pane_id}|#{@pi_worker_run}|#{pane_width}|#{pane_height}").split("\n")
      .map(line => { const [pane, runId, width, height] = line.split("|");
        return { pane, runId, width: Number(width), height: Number(height) }; });
    const checkSizes = async () => {
      await waitFor(() => {
        const rows = geometry();
        if (Math.max(...rows.map(row => row.width)) - Math.min(...rows.map(row => row.width)) > 1) return false;
        return rows.filter(row => row.runId).every(row => {
          const info = snapshots.get(row.runId);
          return info?.width === row.width && info?.height === row.height;
        });
      }, "workers observe actual dimensions and columns remain evenly sized");
    };
    for (let i = 0; i < 3; i++) {
      await start(`root-${i}`);
      await start(`child-${i}`, `root-${i}`);
      await checkSizes();
    }
    for (const width of [181, 233, 197, 233]) {
      cmd("resize-window", "-t", main, "-x", String(width), "-y", "42");
      await checkSizes();
      await delay(30);
    }
    // Fast A->B->A changes while Elapsed is updating.
    for (let i = 0; i < 3; i++) {
      cmd("resize-window", "-t", main, "-x", "185", "-y", "56", ";",
        "resize-window", "-t", main, "-x", "233", "-y", "42");
    }
    await checkSizes();
    for (const { worker } of workers) worker.message("freeze");
    await delay(150);
    const before = new Map();
    for (const row of geometry().filter(row => row.runId)) {
      const screen = cmd("capture-pane", "-p", "-t", row.pane);
      before.set(row.pane, screen);
    }
    for (const { worker } of workers) worker.message("redraw");
    await delay(150);
    for (const [pane, screen] of before) {
      const clean = cmd("capture-pane", "-p", "-t", pane);
      assert.equal(clean, screen,
        "incrementally updated viewport must match a clean full redraw: " + JSON.stringify([...snapshots]));
      assert.equal((clean.match(/Elapsed /g) ?? []).length, 1, clean);
      assert.equal((clean.match(/WORKER /g) ?? []).length, 1, clean);
    }
    // Closing a middle column while the other workers still render must work too.
    workers[3].worker.message("finish");
    assert.equal((await workers[3].worker.done).status, "completed");
    workers[2].worker.message("finish");
    assert.equal((await workers[2].worker.done).status, "completed");
    await checkSizes();
    // Real finish_task refuses to finish a parent before its children settle.
    for (const i of [1, 5]) workers[i].worker.message("finish");
    await Promise.all([workers[1].worker.done, workers[5].worker.done]);
    for (const i of [0, 4]) workers[i].worker.message("finish");
    const results = await Promise.all(workers.map(({ worker }) => worker.done));
    assert.ok(results.every(result => result.status === "completed"), JSON.stringify(results));
    assert.equal(cmd("list-panes", "-t", main, "-F", "#{pane_id}"), main);
    const hooks = cmd("show-hooks", "-w", "-t", main);
    assert.equal((hooks.match(/window-layout-changed\[/g) ?? []).length, 1,
      "remove our layout hook, preserve the user's hook");
    assert.match(hooks, /window-layout-changed\[1\]/);
    for (const { pid } of snapshots.values()) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
  } finally {
    for (const { worker } of workers) worker.stop();
    await Promise.allSettled(workers.map(({ worker }) => worker.done));
    try { cmd("kill-server"); } catch {}
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    await rm(pool, { recursive: true, force: true });
  }
});
