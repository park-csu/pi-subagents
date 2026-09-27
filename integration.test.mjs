import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, copyFile, chmod, readdir, rm, symlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadFixtureRuntime } from "./test-fixtures/runtime.mjs";

function installedPi() {
  if (process.env.PI_TEST_PACKAGE_ROOT) return process.env.PI_TEST_PACKAGE_ROOT;
  try {
    let dir = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
    while (dirname(dir) !== dir) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") return dir;
      dir = dirname(dir);
    }
  } catch { /* The optional integration check needs installed pi. */ }
}

const contract = (objective, write = []) => ({ objective, scope: { read: [], write }, plan: ["Investigate the assigned question"], acceptance: ["Return evidence and limitations"] });
const packageRoot = installedPi();
test("real dispatcher: four parallel parents, nested relays, shared slots and terminal tree", {
  skip: !packageRoot || process.platform === "win32", timeout: 60000,
}, async () => {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "subagents-integration-"));
  const savedEnv = { ...process.env };
  let extension;
  let ctx;
  try {
    await mkdir(join(root, "bin"));
    await mkdir(join(root, "subagents"));
    await writeFile(join(root, "subagents.json"), '{"max_parallel":16,"max_depth":2,"max_children":4,"max_nested_children":2}');
    await writeFile(join(root, "subagents", "researcher.md"), `---
name: researcher
description: Offline fixture
model: fixture/model
thinking: xhigh
callable: true
can_delegate: true
delegatable_agents: [researcher]
tools: [read, bash]
---
Offline fixture only.
`);
    await writeFile(join(root, "subagents", "blocked.md"), `---
name: blocked
description: Role deliberately unavailable to researcher
model: fixture/model
thinking: xhigh
callable: true
can_delegate: false
tools: [read, bash]
---
Offline fixture only.
`);
    await copyFile(join(directory, "test-fixtures", "pi.mjs"), join(root, "bin", "pi"));
    await copyFile(join(directory, "test-fixtures", "runtime.mjs"), join(root, "bin", "runtime.mjs"));
    await chmod(join(root, "bin", "pi"), 0o700);
    // Mark the extensionless fake executable as ESM.
    await writeFile(join(root, "bin", "package.json"), '{"type":"module"}');
    for (const name of Object.keys(process.env)) if (name.startsWith("PI_SUBAGENT_")) delete process.env[name];
    process.env.PATH = `${join(root, "bin")}:${savedEnv.PATH}`;
    // Integration fixture must never split the developer's real tmux window.
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    process.env.PI_CODING_AGENT_DIR = root;
    process.env.PI_SUBAGENT_TEST_LOADER = pathToFileURL(join(packageRoot, "dist", "core", "extensions", "loader.js")).href;
    process.env.PI_SUBAGENT_TEST_EXTENSION = join(directory, "index.ts");
    const loaded = await loadFixtureRuntime();
    ({ extension, ctx } = loaded);
    assert.equal(extension.tools.has("finish_task"), false, "finish_task is worker-only");
    let systemPrompt = "Repository instructions remain intact.";
    for (const hook of extension.handlers.get("before_agent_start")) {
      const result = await hook({ systemPrompt }, ctx);
      systemPrompt = result?.systemPrompt ?? systemPrompt;
    }
    assert.ok(systemPrompt.startsWith("Repository instructions remain intact."));
    assert.match(systemPrompt, /You are the primary agent/);
    assert.match(systemPrompt, /No job or phase requires a subagent/);
    assert.match(systemPrompt, /protected tests and checks/);
    assert.match(systemPrompt, /Handle tiny tasks, known-path reads, and simple lookups directly/);
    assert.match(systemPrompt, /outweighs startup and handoff cost/);
    assert.match(systemPrompt, /never bypass limits through bash/);
    assert.match(systemPrompt, /Callable subagents/);
    assert.equal(systemPrompt.match(/Subagent workflow — primary agent/g).length, 1);
    assert.match(systemPrompt, /Ticket workflow: OFF/);
    assert.doesNotMatch(systemPrompt, /Before implementation, create or reuse/);
    const tickets = extension.commands.get("tickets");
    const commandContext = { ...ctx, ui: { notify() {} } };
    await tickets.handler("on", commandContext);
    assert.ok(loaded.entries.some(entry => entry.customType === "subagents-tickets" && entry.data.enabled === true));
    systemPrompt = "Repository instructions remain intact.";
    for (const hook of extension.handlers.get("before_agent_start")) {
      const result = await hook({ systemPrompt }, ctx);
      systemPrompt = result?.systemPrompt ?? systemPrompt;
    }
    assert.match(systemPrompt, /Ticket workflow: ON/);
    assert.match(systemPrompt, /Before implementation, create or reuse/);
    ctx.cwd = root;
    ctx.mode = "tui";
    ctx.hasUI = true;
    const frames = [];
    let component;
    const tui = { requestRender: () => {
      if (component) frames.push(component.render(80));
    } };
    ctx.ui = { setWidget: (_key, factory) => {
      if (factory) {
        component = factory(tui);
        frames.push(component.render(80));
      } else {
        component = undefined;
      }
    } };
    const updates = [];
    assert.deepEqual(loaded.tool.parameters.required, ["agent", "task"]);
    assert.equal(loaded.tool.parameters.additionalProperties, false);
    assert.equal(loaded.tool.parameters.properties.handoff, undefined);
    assert.deepEqual(loaded.tool.parameters.properties.mode.enum, ["sync", "async"]);
    assert.equal(loaded.tool.parameters.properties.task.type, "object");
    await assert.rejects(loaded.tool.execute("legacy-string", { agent: "researcher", task: "Free text" },
      undefined, undefined, ctx), /JSON contract/);
    await assert.rejects(loaded.tool.execute("invalid-mode",
      { agent: "researcher", task: contract("Invalid mode"), mode: "other" }, undefined, undefined, ctx), /mode/);
    for (const task of [undefined, "", " \n", contract("한".repeat(42667))]) {
      await assert.rejects(loaded.tool.execute("invalid", { agent: "researcher", task },
        undefined, undefined, ctx), /nonempty|120KB/);
    }
    await assert.rejects(extension.commands.get("subagent").handler("researcher " + "x".repeat(128001),
      { ...ctx, waitForIdle: async () => {} }), /128KB/);
    await assert.rejects(loaded.tool.execute("missing-parallel-work", {
      agent: "researcher", task: contract("Work"), mode: "async",
    }, undefined, undefined, ctx), /parallel_work/);
    await assert.rejects(loaded.tool.execute("blank-parallel-work", {
      agent: "researcher", task: contract("Work"), mode: "async", parallel_work: "   ",
    }, undefined, undefined, ctx), /parallel_work/);
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      loaded.tool.execute(`root-${i}`, { agent: "researcher", task: contract(`Root ${i}\nKeep interface tests unchanged. Read docs/contract.md.`, [`owned-${i}.ts`]), mode: "async", parallel_work: "Launch independent sibling investigations" }, undefined,
        update => updates.push(update.details), ctx)));
    assert.deepEqual(results.map(r => r.details.status), ["running", "running", "running", "running"]);
    await assert.rejects(loaded.tool.execute("overlap", {
      agent: "researcher", task: contract("Conflicting writer", ["./owned-0.ts"]),
    }, undefined, undefined, ctx), /Write scope overlaps/);
    await symlink(root, join(root, "alias"));
    await assert.rejects(loaded.tool.execute("alias-overlap", {
      agent: "researcher", task: contract("Aliased writer", ["alias/owned-0.ts"]),
    }, undefined, undefined, ctx), /Write scope overlaps/);
    await assert.rejects(loaded.tool.execute("directory-overlap", {
      agent: "researcher", task: contract("Whole directory writer", ["."]),
    }, undefined, undefined, ctx), /Write scope overlaps/);
    await tickets.handler("off", commandContext);
    assert.equal(loaded.messages.length, 0, "startup acknowledgements precede completion");
    for (const [i, result] of results.entries()) {
      const saved = JSON.parse(readFileSync(join(result.details.runDir, "loadout.json"), "utf8"));
      assert.equal(saved.contract.objective, `Root ${i}\nKeep interface tests unchanged. Read docs/contract.md.`,
        "task is passed verbatim; referenced documents are not automatically loaded");
    }
    for (const mode of ["tui", "rpc"]) {
      for (const handler of extension.handlers.get("agent_settled") ?? []) {
        await handler({}, { ...ctx, mode, isIdle: () => false });
      }
      assert.equal(loaded.messages.length, 0, `${mode} must return while workers are still running`);
    }
    ctx.ui.notify = () => {};
    const input = extension.handlers.get("input")[0];
    const resumed = input({ source: "interactive", text: "continue" }, ctx);
    assert.deepEqual(resumed, { action: "continue" }, "resume must not hold prompt preflight open");
    assert.deepEqual(input({ source: "interactive", text: "steer while collecting" }, ctx),
      { action: "continue" });
    const deadline = Date.now() + 15000;
    const completions = () => loaded.messages.filter(message => message.customType === "subagent-completion");
    while (!completions().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(completions().length > 0 && completions().length < 4, "fast worker reports before slow sibling finishes");
    while (completions().length < 4 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(completions().length, 4);
    assert.equal(new Set(completions().map(message => message.details.runId)).size, 4, "exactly one completion per run");
    for (const result of results) {
      const final = completions().find(message => message.details.runId === result.details.runId);
      assert.equal(final.details.status, "completed", final.content);
      assert.match(final.content, /Tickets: on/, "live workers retain their launch snapshot");
      assert.ok(Math.abs(final.details.usage.cost.total - 0.03) < 1e-9);
      const lines = loaded.tool.renderResult(result, { expanded: false, isPartial: false }, { fg: (_c, text) => text, bold: text => text }).render(80);
      assert.match(lines.join("\n"), /Write scope/);
      assert.match(lines.join("\n"), /Acceptance/);
      assert.match(lines.join("\n"), /async/);
      assert.ok(lines.every(line => line.length <= 80));
      const expanded = loaded.tool.renderResult(result, { expanded: true, isPartial: false },
        { fg: (_c, text) => text, bold: text => text }).render(120).join("\n");
      assert.match(expanded, /Plan/);
      assert.match(expanded, /pending parent verification/);
      assert.ok(expanded.includes(final.details.runDir));
      const stale = { ...result, details: { ...result.details, status: "paused" } };
      const refreshed = loaded.tool.renderResult(stale, { expanded: false, isPartial: false },
        { fg: (_c, text) => text, bold: text => text }).render(80);
      assert.match(refreshed[0], /completed/);
      assert.ok(!refreshed[0].includes("paused"));
    }
    assert.ok(updates.length >= 4, "startup progress remains available before acknowledgement");
    assert.ok(frames.some(lines => lines.length >= 4), "multiple workers must coexist in the widget");
    assert.ok(frames.some(lines => lines.some(line => line.startsWith("└─"))), "nested progress must reach root UI");
    const pools = (await readdir(join(root, "subagent-runs"))).filter(name => name.startsWith("pool-"));
    assert.equal(pools.length, 1);
    assert.deepEqual(await readdir(join(root, "subagent-runs", pools[0])), []);
    const messenger = extension.tools.get("delegate_message").definition;
    await assert.rejects(messenger.execute("unknown", { name: "unknown", message: "Continue" },
      undefined, undefined, ctx), /Unknown worker/);
    const old = JSON.parse(readFileSync(join(results[0].details.runDir, "loadout.json"), "utf8"));
    const name = results[0].details.name;
    const restored = await messenger.execute("restore", { name, message: "Continue within the original contract" },
      undefined, undefined, ctx);
    assert.equal(restored.details.name, name);
    assert.notEqual(restored.details.runId, results[0].details.runId);
    const saved = JSON.parse(readFileSync(join(restored.details.runDir, "loadout.json"), "utf8"));
    assert.equal(saved.sessionFile, old.sessionFile);
    assert.equal(saved.task, old.task);
    assert.deepEqual(saved.contract, old.contract);
    await messenger.execute("steer", { name, message: "LIVE_STEER_MARKER" }, undefined, undefined, ctx);
    const restoredDeadline = Date.now() + 15000;
    while (completions().length < 5 && Date.now() < restoredDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(completions().length, 5);
    assert.equal(completions()[4].details.status, "completed");
    assert.match(completions()[4].content, /Tickets: off/, "restored workers inherit current parent mode");
    assert.match(completions()[4].content, /LIVE_STEER_MARKER/);
    const synchronous = await loaded.tool.execute("sync",
      { agent: "researcher", task: contract("Synchronous work") }, undefined, undefined, ctx);
    assert.equal(synchronous.details.status, "completed");
    assert.equal(synchronous.details.mode, "sync");
    assert.match(synchronous.content[0].text, /Fixture depth 1 completed/);
    assert.equal(completions().length, 5, "sync returns the report without a duplicate completion turn");
    assert.ok(Math.abs(synchronous.usage.cost.total - 0.03) < 1e-9, "sync propagates nested usage");
    const failedSync = await loaded.tool.execute("sync-failure",
      { agent: "researcher", task: contract("FAIL_AFTER_START"), mode: "sync" }, undefined, undefined, ctx);
    assert.equal(failedSync.details.status, "failed");
    assert.match(failedSync.content[0].text, /Child exited 4/);
    assert.equal(completions().length, 5, "sync failures do not send duplicate completion messages");
    const cancelled = new AbortController();
    const pending = loaded.tool.execute("cancel-sync",
      { agent: "researcher", task: contract("Synchronous cancellation"), mode: "sync" }, cancelled.signal,
      update => { if (update.details.runDir) cancelled.abort(); }, ctx);
    await assert.rejects(pending, /abort|cancel/i);
    assert.equal(completions().length, 5);
    const researcherPath = join(root, "subagents", "researcher.md");
    const definition = readFileSync(researcherPath, "utf8");
    await writeFile(researcherPath, definition.replace("delegatable_agents: [researcher]", "delegatable_agents: [blocked]"));
    await assert.rejects(messenger.execute("revoked", { name, message: "Restore after role revocation" },
      undefined, undefined, ctx), /no longer authorized/);
    await writeFile(researcherPath, definition);
    for (const prefix of ["", "--sync "]) {
      await extension.commands.get("subagent").handler(prefix + "researcher Manual synchronous task",
        { ...ctx, waitForIdle: async () => {} });
      const manual = loaded.messages.at(-1);
      assert.equal(manual.details.mode, "sync");
      assert.equal(manual.details.status, "completed");
      assert.equal(completions().length, 5);
    }
    const manualTask = 'Stop this worker on shutdown\nRead "docs/task.md"; do not load it automatically.';
    await extension.commands.get("subagent").handler("--async researcher " + manualTask,
      { ...ctx, waitForIdle: async () => {} });
    const stopping = loaded.messages.at(-1);
    assert.equal(stopping.customType, "subagent-result");
    assert.equal(JSON.parse(readFileSync(join(stopping.details.runDir, "loadout.json"), "utf8")).task, manualTask);
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    }
    const stopped = JSON.parse(readFileSync(join(stopping.details.runDir, "result.json"), "utf8"));
    assert.equal(stopped.status, "cancelled");
    assert.equal(completions().length, 5, "shutdown must not trigger another parent turn");
    assert.deepEqual(await readdir(join(root, "subagent-runs", pools[0])), []);
  } finally {
    for (const handler of extension?.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
    Object.assign(process.env, savedEnv);
    await rm(root, { recursive: true, force: true });
  }
});
