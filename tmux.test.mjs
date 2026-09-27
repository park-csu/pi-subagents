import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkerPane, paneLayout } from "./tmux.ts";
import { runChild, startWorker } from "./core.ts";

test("no tmux means headless fallback", async () => {
  assert.equal(await openWorkerPane({ env: {} }), undefined);
  assert.throws(() => paneLayout(4, 20, [["%1"], ["%2"]]), /small/);
  assert.throws(() => paneLayout(80, 20, [["bad"]]), /Invalid/);
});

const available = spawnSync("tmux", ["-V"]).status === 0;
test("isolated tmux: real child TTY, FD3 results, nesting, equal columns, cancellation and fallback", {
  skip: !available, timeout: 30000,
}, async () => {
  const socket = `pi-panes-test-${randomUUID()}`;
  const args = ["-L", socket, "-f", "/dev/null"];
  const cmd = (...rest) => execFileSync("tmux", [...args, ...rest], {
    encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const pool = await mkdtemp(join(tmpdir(), "pi-tmux-test-"));
  const saved = { ...process.env };
  const leases = [];
  try {
    const main = cmd("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "fixture", "-x", "180", "-y", "60", "sleep 60");
    process.env.TMUX = cmd("display-message", "-p", "-t", main, "#{socket_path},#{pid},0");
    process.env.TMUX_PANE = main;
    delete process.env.PI_SUBAGENT_TMUX_MAIN;
    const errors = [];
    const open = async (runId, parentRunId = "") => {
      const pane = await openWorkerPane({ pool, runId, parentRunId, onError: error => errors.push(error) });
      if (pane) leases.push(pane);
      return pane;
    };
    const a = await open("a"), b = await open("b"), child = await open("child", "a");
    assert.deepEqual(errors, []);
    const rows = cmd("list-panes", "-t", main, "-F",
      "#{pane_id}|#{pane_width}|#{pane_left}|#{pane_top}|#{pane_height}")
      .split("\n").map(line => line.split("|"));
    const geometry = id => rows.find(row => row[0] === id).slice(1).map(Number);
    const m = geometry(main), ga = geometry(a.pane), gb = geometry(b.pane), gc = geometry(child.pane);
    assert.ok(Math.max(m[0], ga[0], gb[0]) - Math.min(m[0], ga[0], gb[0]) <= 1);
    assert.equal(m[1], 0);
    assert.equal(gc[1], ga[1]);
    assert.equal(gc[0], ga[0]);
    assert.ok(gc[2] > ga[2]);
    assert.equal(m[3], 60);
    assert.equal(gb[3], 60);
    assert.equal(cmd("display-message", "-p", "-t", main, "#{window_width} #{window_height}"), "180 60");
    for (const pane of leases.reverse()) await pane.close();
    leases.length = 0;

    const script = `
      import {writeSync} from 'node:fs';
      if(!process.stdin.isTTY || !process.stdout.isTTY) throw Error('Not a real TTY');
      console.log('REAL_TERMINAL_CHILD');
      setTimeout(() => {
        writeSync(3,JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',
          content:[{type:'text',text:'terminal result'}],usage:{input:1,output:1,cost:{total:0.01}}}})+'\\n');
        writeSync(3,JSON.stringify({type:'worker_task_done',report:'terminal result'})+'\\n');
      },700);
    `;
    const options = { agent: { name: "fixture", model: "fixture/model", thinking: "low",
      tools: [], can_delegate: false, systemPrompt: "Fixture" },
      task: "fixture task", cwd: pool, runsDir: pool, pool, extensionPath: "/unused",
      useTmux: true, command: process.execPath, prefix: ["--input-type=module", "-e", script, "--"],
      runId: randomUUID(), killGraceMs: 50 };
    const running = runChild(options);
    // Startup includes the tmux launcher/relay handshake. Wait for observable
    // output, not a fixed delay that flakes under the parallel offline suite.
    let terminalScreen = "";
    for (let i = 0; i < 100 && !terminalScreen.includes("REAL_TERMINAL_CHILD"); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      const workerPane = cmd("list-panes", "-t", main, "-F", "#{pane_id}").split("\n").find(p => p !== main);
      if (workerPane) terminalScreen = cmd("capture-pane", "-p", "-t", workerPane);
    }
    assert.match(terminalScreen, /REAL_TERMINAL_CHILD/);
    const result = await running;
    assert.equal(result.status, "completed");
    assert.equal(result.output, "terminal result");
    assert.equal(result.usage.cost.total, 0.01);
    assert.equal(cmd("list-panes", "-t", main, "-F", "#{pane_id}"), main);

    const cancelled = startWorker({ ...options, waitForSession: false, runId: randomUUID(),
      prefix: ["--input-type=module", "-e", "setInterval(()=>{},100)", "--"] });
    await new Promise(resolve => setTimeout(resolve, 200));
    cancelled.stop();
    assert.equal((await cancelled.done).status, "cancelled");
    assert.equal(cmd("list-panes", "-t", main, "-F", "#{pane_id}"), main);
    const controller = new AbortController();
    let reportPause;
    const paused = new Promise(resolve => { reportPause = resolve; });
    const pauseScript = `
      import {writeSync} from 'node:fs';
      import {Socket} from 'node:net';
      const emit=event=>writeSync(3,JSON.stringify(event)+'\\n');
      let resumes=0;
      new Socket({fd:4,readable:true,writable:false}).on('data',chunk=>{
        if(chunk.toString().trim()==='interrupt'){emit({type:'worker_paused'});return}
        if(JSON.parse(chunk.toString()).type!=='resume')return;
        emit({type:'worker_resumed'});
        if(++resumes===1){setTimeout(()=>emit({type:'worker_paused'}),20);return}
        setTimeout(()=>{
          emit({type:'message_end',message:{role:'assistant',stopReason:'stop',
            content:[{type:'text',text:'continued in same session'}]}});
          emit({type:'worker_task_done',report:'continued in same session'});
          process.exit(0);
        },50);
      });
    `;
    const pausing = startWorker({ ...options, waitForSession: false, runId: randomUUID(), signal: controller.signal,
      onProgress: value => { if (value.status === "paused") reportPause(value); },
      prefix: ["--input-type=module", "-e", pauseScript, "--"] });
    const started = await pausing.ready;
    let ended = false;
    pausing.done.finally(() => { ended = true; });
    controller.abort();
    assert.equal((await paused).status, "paused");
    assert.equal(ended, false, "pause retains ownership and leaves done pending");
    assert.equal(pausing.phase, "paused");
    assert.equal(cmd("list-panes", "-t", main, "-F", "#{pane_id}").split("\n").length, 2);
    await access(started.sessionFile + ".lock");
    const pausedAgain = new Promise(resolve => { reportPause = resolve; });
    pausing.resume();
    pausing.resume(); // Duplicate requests cannot start a second continuation.
    await pausedAgain;
    assert.equal(ended, false);
    assert.equal(pausing.phase, "paused");
    await access(started.sessionFile + ".lock");
    pausing.resume();
    const continued = await pausing.done;
    await assert.rejects(access(started.sessionFile + ".lock"), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(join(started.runDir, "result.json"), "utf8")).status, "completed");
    assert.equal(pausing.phase, "ended");
    assert.equal(continued.status, "completed", JSON.stringify(continued));
    assert.equal(continued.output, "continued in same session");
    assert.equal(cmd("list-panes", "-t", main, "-F", "#{pane_id}"), main);
    let pausedForShutdown;
    const shutdownPause = new Promise(resolve => { pausedForShutdown = resolve; });
    const stoppingPaused = startWorker({ ...options, waitForSession: false, runId: randomUUID(),
      prefix: ["--input-type=module", "-e", pauseScript, "--"],
      onProgress: value => { if (value.status === "paused") pausedForShutdown(); } });
    const shutdownStarted = await stoppingPaused.ready;
    stoppingPaused.interrupt();
    await shutdownPause;
    stoppingPaused.stop();
    stoppingPaused.stop();
    stoppingPaused.resume();
    assert.equal((await stoppingPaused.done).status, "cancelled");
    await assert.rejects(access(shutdownStarted.sessionFile + ".lock"), { code: "ENOENT" });
    assert.equal(cmd("list-panes", "-t", main, "-F", "#{pane_id}"), main);
    if (spawnSync("which", ["pi"]).status === 0) {
      process.env.PI_OFFLINE = "1";
      let finished = false;
      const actualPi = runChild({ ...options,
        agent: { ...options.agent, model: "openai-codex/gpt-5.6-luna", thinking: "xhigh", tools: ["read", "bash"] },
        command: "pi", prefix: [], task: "/offline-pane-test", runId: randomUUID(),
        extensionPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
        toolExtensions: [fileURLToPath(new URL("./test-fixtures/terminal-smoke.ts", import.meta.url))],
      }).finally(() => { finished = true; });
      let screen = "";
      while (!finished) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const id = cmd("list-panes", "-t", main, "-F", "#{pane_id}").split("\n").find(p => p !== main);
        if (id) {
          try { screen += cmd("capture-pane", "-p", "-t", id); } catch { /* Child just closed. */ }
        }
      }
      const piResult = await actualPi;
      assert.equal(piResult.status, "completed", JSON.stringify(piResult) + "\n" + screen.slice(-5000));
      assert.equal(piResult.output, "offline actual Pi completed");
      assert.match(screen, /PI_TUI_OFFLINE_MARKER/);
    }
    const conflict = await open("conflict");
    const other = cmd("split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-t", main, "sleep 60");
    await conflict.close();
    assert.deepEqual(new Set(cmd("list-panes", "-t", main, "-F", "#{pane_id}").split("\n")),
      new Set([main, other]), "owned pane closes even after an unrelated pane appears");
    assert.equal(await open("c"), undefined);
    assert.match(errors.at(-1), /Unrelated/);
    assert.deepEqual(new Set(cmd("list-panes", "-t", main, "-F", "#{pane_id}").split("\n")), new Set([main, other]));
  } finally {
    for (const pane of leases) await pane.close();
    try { cmd("kill-server"); } catch { /* Test server only. */ }
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    await rm(pool, { recursive: true, force: true });
  }
});
