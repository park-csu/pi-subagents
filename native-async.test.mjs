import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { runChild } from "./core.ts";
import { createPool, DEFAULT_LIMITS } from "./limits.ts";

test("actual Pi depth-zero and nested headless parents await results and restore sessions (no network)", {
  skip: spawnSync("which", ["pi"]).status !== 0, timeout: 65000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "native-async-worker-"));
  const original = { ...process.env };
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    process.env.PI_OFFLINE = "1";
    for (const name of Object.keys(process.env)) if (name.startsWith("PI_SUBAGENT_")) delete process.env[name];
    delete process.env.TMUX; delete process.env.TMUX_PANE;
    await writeFile(join(root, "subagents.json"), '{"max_depth":2}');
    await mkdir(join(root, "subagents"));
    await writeFile(join(root, "subagents", "researcher.md"), `---
name: researcher
description: Offline fixture
model: offline-worker/fixture
thinking: off
callable: true
can_delegate: true
delegatable_agents: [researcher]
tools: [offline_marker]
---
Offline fixture only.
`);
    const runsDir = join(root, "subagent-runs");
    const options = {
      agent: { name: "researcher", description: "Offline", model: "offline-worker/fixture",
        thinking: "off", callable: true, can_delegate: true, delegatable_agents: ["researcher"], tools: ["offline_marker"], systemPrompt: "Offline fixture only." },
      task: "Native async fixture", cwd: root, runsDir, pool: await createPool(runsDir),
      limits: { ...DEFAULT_LIMITS, max_depth: 2 },
      extensionPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
      toolExtensions: [fileURLToPath(new URL("./test-fixtures/offline-provider.ts", import.meta.url))],
      waitForSession: true,
    };
    // A real depth-zero parent has no supervisor FDs. Both print transports
    // must retain it until the child's completion has driven its final turn.
    for (const executionMode of ["async", "sync"]) for (const mode of ["text", "json"]) {
      const parent = spawnSync("pi", ["-p", "--mode", mode, "--no-session", "--no-approve",
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
        "-e", options.extensionPath, "-e", options.toolExtensions[0],
        "--model", "offline-worker/fixture", "--thinking", "off",
        "--tools", "offline_marker,delegate,delegate_message", "Native async fixture"], {
        cwd: root, env: { ...process.env, OFFLINE_FIXTURE_PARENT_DEPTH: "0",
          OFFLINE_FIXTURE_MODE: executionMode, OFFLINE_FIXTURE_REMINDER: "1" },
        encoding: "utf8", timeout: 15000,
      });
      assert.equal(parent.error, undefined);
      assert.equal(parent.status, 0, parent.stderr);
      assert.match(parent.stdout, /PARENT_NATIVE_DONE/, `${mode}: ${parent.stdout}\n${parent.stderr}`);
      if (mode === "json") {
        for (const line of parent.stdout.trim().split("\n")) JSON.parse(line);
        if (executionMode === "async") assert.match(parent.stdout, /PARENT_WAITING/);
        else {
          assert.doesNotMatch(parent.stdout, /PARENT_WAITING/);
          assert.doesNotMatch(parent.stdout, /"customType":"subagent-completion"/);
        }
      }
    }
    const artifacts = (await readdir(runsDir)).filter(name => !name.startsWith("pool-"));
    assert.equal(artifacts.length, 4);
    for (const name of artifacts) {
      const result = JSON.parse(await readFile(join(runsDir, name, "result.json"), "utf8"));
      assert.equal(result.status, "completed");
      assert.equal(result.output, "LEAF_NATIVE_OK");
      assert.match(await readFile(join(runsDir, name, "events.jsonl"), "utf8"), /finish-task-reminder/);
    }
    const first = await runChild({ ...options, runId: randomUUID() });
    assert.equal(first.status, "completed", JSON.stringify(first));
    assert.equal(first.output, "PARENT_NATIVE_DONE");
    const events = await readFile(join(first.runDir, "events.jsonl"), "utf8");
    assert.match(events, /PARENT_WAITING/);
    assert.match(events, /LEAF_NATIVE_OK/);
    for (const line of events.trim().split("\n")) JSON.parse(line);
    await mkdir(first.sessionFile + ".lock");
    try {
      await assert.rejects(runChild({ ...options, runId: randomUUID(), resumeSession: first.sessionFile }),
        /already owned/);
    } finally { await rm(first.sessionFile + ".lock", { recursive: true }); }
    const second = await runChild({ ...options, runId: randomUUID(), resumeSession: first.sessionFile,
      task: "Confirm that the previous conversation was restored." });
    assert.equal(second.status, "completed", JSON.stringify(second));
    assert.equal(second.output, "RESTORED_NATIVE_OK");
    assert.equal(second.sessionFile, first.sessionFile);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    await rm(root, { recursive: true, force: true });
  }
});
