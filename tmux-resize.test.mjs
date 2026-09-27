import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkerPane } from "./tmux.ts";

const available = process.platform !== "win32" && spawnSync("tmux", ["-V"]).status === 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";

test("isolated tmux: existing PTY sees final-only sizes on open/close, including nested cleanup", {
  skip: !available, timeout: 30000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-resize-test-"));
  const savedPath = process.env.PATH;
  const tmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
  const args = ["-L", `pi-resize-test-${randomUUID()}`, "-f", "/dev/null"];
  const cmd = (...rest) => execFileSync(tmux, [...args, ...rest], {
    encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const leases = [];
  try {
    // Give tmux time to deliver each resize between separate command queues.
    // Without this gap, SIGWINCH coalescing can mask the old transient geometry.
    // A single batched queue still has no gap between its mutations.
    await writeFile(join(dir, "tmux"),
      `#!/bin/sh\n${quote(tmux)} "$@"\nresult=$?\nsleep 0.06\nexit "$result"\n`, { mode: 0o700 });
    process.env.PATH = `${dir}:${savedPath}`;
    const sizes = join(dir, "sizes.jsonl");
    const observer = join(dir, "observe.mjs");
    await writeFile(observer, `
      import {appendFileSync} from "node:fs";
      const record = () => appendFileSync(process.argv[2],
        JSON.stringify([process.stdout.columns, process.stdout.rows]) + "\\n");
      process.stdout.on("resize", record);
      record();
      setInterval(() => {}, 100);
    `);
    const main = cmd("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "fixture",
      "-x", "233", "-y", "49", [process.execPath, observer, sizes].map(quote).join(" "));
    const env = { TMUX: cmd("display-message", "-p", "-t", main, "#{socket_path},#{pid},0"),
      TMUX_PANE: main };
    const observed = async () => (await readFile(sizes, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    // Bounded readiness wait for the real PTY observer, not an agent/process poll.
    for (let i = 0; i < 100; i++) {
      try { if ((await observed()).length) break; } catch {}
      await delay(20);
    }
    assert.deepEqual(await observed(), [[233, 49]]);
    const open = async (runId, parentRunId = "") => {
      const errors = [];
      const pane = await openWorkerPane({ pool: dir, runId, parentRunId, env, tmuxArgs: args,
        onError: error => errors.push(error) });
      assert.ok(pane, errors.join("\n"));
      leases.push(pane);
      return pane;
    };
    const a = await open("a");
    const b = await open("b");
    const child = await open("child", "a");
    await delay(100);
    assert.deepEqual(await observed(), [[233, 49], [116, 49], [77, 49]],
      "opening a second column must not briefly shrink main to 58 columns");
    await writeFile(sizes, "");
    await b.close();
    await delay(100);
    assert.deepEqual(await observed(), [[116, 49]],
      "closing a middle column must not briefly expand main to 155 columns");
    await writeFile(sizes, "");
    await a.close(); // Closes its nested placeholder in the same queue.
    await delay(100);
    assert.deepEqual(await observed(), [[233, 49]]);
    assert.equal(cmd("list-panes", "-t", main, "-F", "#{pane_id}"), main);
    await child.close(); // Already removed by its ancestor; cleanup is idempotent.

    const own = await open("with-user-pane");
    const unrelated = cmd("split-window", "-v", "-d", "-P", "-F", "#{pane_id}",
      "-t", main, "sleep 30");
    await own.close();
    assert.deepEqual(new Set(cmd("list-panes", "-t", main, "-F", "#{pane_id}").split("\n")),
      new Set([main, unrelated]), "a later user pane must not prevent owned-pane cleanup");
    cmd("kill-pane", "-t", unrelated);

    const small = await open("before-shrink");
    cmd("resize-window", "-t", main, "-x", "15", "-y", "10");
    await small.close();
    assert.equal(cmd("list-panes", "-t", main, "-F", "#{pane_id}"), main,
      "a now-too-small window must not strand a worker placeholder");
  } finally {
    for (const pane of leases.reverse()) await pane.close();
    process.env.PATH = savedPath;
    try { cmd("kill-server"); } catch { /* This test's named socket only. */ }
    await rm(dir, { recursive: true, force: true });
  }
});
