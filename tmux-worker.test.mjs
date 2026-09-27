import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startWorker } from "./core.ts";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test("tmux relay fails closed on startup, pane loss, output overflow and cancellation", {
  skip: process.platform !== "linux" || spawnSync("tmux", ["-V"]).status !== 0,
  timeout: 20000,
}, async () => {
  const pool = await mkdtemp(join(tmpdir(), "pi-tmux-lifecycle-"));
  const saved = { ...process.env };
  const args = ["-L", `pi-tmux-lifecycle-${randomUUID()}`, "-f", "/dev/null"];
  const cmd = (...rest) => execFileSync("tmux", [...args, ...rest], {
    encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const workers = [];
  try {
    const main = cmd("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "fixture",
      "-x", "160", "-y", "40", "sleep 60");
    process.env.TMUX = cmd("display-message", "-p", "-t", main, "#{socket_path},#{pid},0");
    process.env.TMUX_PANE = main;
    delete process.env.PI_SUBAGENT_TMUX_MAIN;
    const start = (script, overrides = {}) => {
      const worker = startWorker({
        agent: { name: "fixture", model: "fixture/model", thinking: "low",
          tools: [], can_delegate: false, systemPrompt: "Fixture" },
        task: "offline transport fixture", cwd: pool, runsDir: pool, pool,
        extensionPath: "/unused", useTmux: true, runId: randomUUID(),
        waitForSession: true, killGraceMs: 50,
        command: process.execPath, prefix: ["--input-type=module", "-e", script, "--"],
        ...overrides,
      });
      workers.push(worker);
      return worker;
    };
    const missing = start("", { command: join(pool, "nonexistent"), prefix: [] });
    await assert.rejects(missing.ready);
    assert.equal((await missing.done).status, "failed");
    assert.equal(cmd("list-panes", "-t", main, "-F", "#{pane_id}"), main);
    const unterminated = start(`
      import {writeSync} from "node:fs";
      writeSync(3,JSON.stringify({type:"worker_ready"})+"\\n");
      writeSync(3,JSON.stringify({type:"worker_task_done",report:"last record without newline"}));
    `);
    const lastRecord = await unterminated.done;
    assert.equal(lastRecord.status, "completed", JSON.stringify(lastRecord));
    assert.equal(lastRecord.output, "last record without newline");

    const idle = `
      import {writeSync} from "node:fs";
      writeSync(3, JSON.stringify({type: "worker_ready"}) + "\\n");
      setInterval(() => {}, 100);
    `;
    const closed = start(idle);
    await closed.ready;
    const pane = cmd("list-panes", "-t", main, "-F", "#{pane_id}").split("\n").find(id => id !== main);
    cmd("kill-pane", "-t", pane);
    const closedResult = await closed.done;
    assert.equal(closedResult.status, "cancelled", JSON.stringify(closedResult));

    const oversized = start(idle + `writeSync(3, "x".repeat(10000));`, { maxOutputBytes: 1000 });
    const overflow = await oversized.done;
    assert.equal(overflow.status, "failed");
    assert.match(overflow.error, /Output limit/);

    let descendants;
    const resistant = start(`
      import {spawn} from "node:child_process";
      import {writeSync} from "node:fs";
      process.on("SIGTERM", () => {});
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},100)"]);
      writeSync(3, JSON.stringify({type:"worker_progress",info:{pid:process.pid, child:child.pid}})+"\\n");
      writeSync(3, JSON.stringify({type:"worker_ready"})+"\\n");
      setInterval(()=>{},100);
    `, { onDescendant: info => { descendants = info; } });
    await resistant.ready;
    assert.ok(descendants?.pid && descendants?.child);
    resistant.stop();
    assert.equal((await resistant.done).status, "cancelled");
    const running = pid => {
      try {
        const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return state && !state.startsWith("Z");
      } catch { return false; }
    };
    for (let i = 0; i < 100 && Object.values(descendants).some(running); i++) await delay(10);
    assert.ok(!Object.values(descendants).some(running), "no TERM-resistant process survives relay disconnection");
    assert.equal(cmd("list-panes", "-t", main, "-F", "#{pane_id}"), main);
    // A nested TUI has a separate terminal group. Losing its parent must still
    // close the nested relay and kill that group's worker.
    let nestedPid;
    const nestedScript = `
      import {writeSync} from "node:fs";
      process.on("SIGTERM", () => {});
      writeSync(3,JSON.stringify({type:"worker_progress",info:{nestedPid:process.pid}})+"\\n");
      writeSync(3,JSON.stringify({type:"worker_ready"})+"\\n");
      setInterval(()=>{},100);
    `;
    const parent = start(`
      import {writeSync} from "node:fs";
      import {startWorker} from ${JSON.stringify(new URL("./core.ts", import.meta.url).href)};
      process.on("SIGTERM", () => {});
      const child = startWorker({
        agent:{name:"fixture",model:"fixture/model",thinking:"low",tools:[],can_delegate:false,systemPrompt:"Fixture"},
        task:"nested offline fixture",cwd:process.cwd(),runsDir:process.cwd(),
        pool:process.env.PI_SUBAGENT_POOL,extensionPath:"/unused",useTmux:true,depth:1,
        parentRunId:process.env.PI_SUBAGENT_RUN_ID,runId:"nested-fixture",
        command:process.execPath,prefix:["--input-type=module","-e",${JSON.stringify(nestedScript)},"--"],
        onDescendant:info=>writeSync(3,JSON.stringify({type:"worker_progress",info})+"\\n"),
      });
      await child.ready;
      writeSync(3,JSON.stringify({type:"worker_ready"})+"\\n");
      setInterval(()=>{},100);
    `, { onDescendant: info => { nestedPid = info.nestedPid; } });
    await parent.ready;
    assert.ok(nestedPid);
    parent.stop();
    assert.equal((await parent.done).status, "cancelled");
    for (let i = 0; i < 100 && running(nestedPid); i++) await delay(10);
    assert.ok(!running(nestedPid), "separate nested terminal group is also terminated");
    for (let i = 0; i < 100 &&
      cmd("list-panes", "-t", main, "-F", "#{pane_id}") !== main; i++) await delay(10);
    assert.equal(cmd("list-panes", "-t", main, "-F", "#{pane_id}"), main);
    assert.doesNotMatch(cmd("show-hooks", "-w", "-t", main), /window-layout-changed\[/);
  } finally {
    for (const worker of workers) worker.stop();
    await Promise.allSettled(workers.map(worker => worker.done));
    try { cmd("kill-server"); } catch {}
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    await rm(pool, { recursive: true, force: true });
  }
});
