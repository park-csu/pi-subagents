import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validateDefinition, authorize, childArgs, runChild, validateTask, resolveTools, descendantProgress } from "./core.ts";

const raw = { name: "worker", description: "Test", model: "provider/model",
  thinking: "xhigh", callable: true, can_delegate: false, tools: ["read", "bash"] };
const agent = validateDefinition(raw, "Do the task.", "worker.md");

test("turn counts remain observational without an execution limit", async () => {
  const completed = await runFake(`
    for(let i=0;i<40;i++) console.log(JSON.stringify({type:'message_end',
      message:{role:'assistant',stopReason:'toolUse',content:[]}}));
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',
      stopReason:'stop',content:[{type:'text',text:'Final report'}]}}));
    console.log(JSON.stringify({type:'worker_task_done',report:'Final report'}));
  `);
  assert.equal(completed.status, "completed");
  assert.equal(completed.output, "Final report");
  assert.equal(completed.turns, 41);
});

test("strict definitions and delegation policy", () => {
  assert.throws(() => validateDefinition({ ...raw, nestable: true }, "x", "x"));
  assert.throws(() => validateDefinition({ ...raw, callable: "false" }, "x", "x"));
  assert.throws(() => validateDefinition({ ...raw, model: "model" }, "x", "x"));
  assert.throws(() => validateDefinition({ ...raw, tools: ["delegate"] }, "x", "x"));
  assert.throws(() => authorize({ ...agent, callable: false }));
  authorize({ ...agent, callable: false }, { manual: true });
  assert.throws(() => authorize(agent, { depth: 1, canDelegate: false }));
  assert.throws(() => authorize(agent, { depth: 2 }));
  assert.throws(() => authorize(agent, { depth: NaN }));
  authorize(agent, { depth: 1, canDelegate: true });
});

test("delegatable_agents restricts automated and manual delegation without bypassing depth", () => {
  const definition = validateDefinition({ ...raw, can_delegate: true,
    delegatable_agents: ["worker", "reviewer", "worker"] }, "Task", "worker.md");
  assert.deepEqual(definition.delegatable_agents, ["worker", "reviewer"]);
  for (const delegatable_agents of [undefined, [], ["../escape"], "worker", Array(65).fill("worker")]) {
    assert.throws(() => validateDefinition({ ...raw, can_delegate: true, delegatable_agents }, "Task", "worker.md"));
  }
  assert.throws(() => validateDefinition({ ...raw, delegatable_agents: ["worker"] }, "Task", "worker.md"));
  for (const manual of [false, true]) {
    authorize(agent, { depth: 1, manual, delegatableAgents: ["worker"] });
    assert.throws(() => authorize(agent, { depth: 1, manual, delegatableAgents: ["reviewer"] }), /not permitted/);
    assert.throws(() => authorize(agent, { depth: 1, manual, delegatableAgents: [] }), /not permitted/);
    assert.throws(() => authorize(agent, { depth: 2, manual, delegatableAgents: ["worker"] }), /depth/);
  }
});

test("explicit child resources and nesting allowlist", () => {
  const args = childArgs(agent, "/extension.ts", "/prompt.md");
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes("--no-approve"));
  assert.equal(args[args.indexOf("--thinking") + 1], "xhigh");
  assert.ok(!args[args.indexOf("--tools") + 1].includes("delegate"));
  const nested = childArgs({ ...agent, can_delegate: true, delegatable_agents: ["worker"] }, "e", "p");
  assert.ok(nested[nested.indexOf("--tools") + 1].includes("delegate"));
});

test("tool sources use active parent registry and explicit extensions", () => {
  const tools = [{ name: "read", sourceInfo: { source: "builtin" } },
    { name: "web_search", sourceInfo: { source: "extension", path: "/web/index.ts" } },
    { name: "web_fetch", sourceInfo: { source: "extension", path: "/web/index.ts" } }];
  const paths = resolveTools(["read", "web_search", "web_fetch"], tools, tools.map(t => t.name));
  assert.deepEqual(paths, ["/web/index.ts"]);
  assert.throws(() => resolveTools(["web_search"], tools, ["read"]));
  assert.throws(() => resolveTools(["missing"], tools, ["missing"]));
  assert.ok(childArgs(agent, "/self.ts", "/prompt.md", paths).includes("/web/index.ts"));
});

test("free-form task validation preserves text and bounds UTF-8 size", () => {
  const task = 'Implement parser\nKeep "interface tests" unchanged. Read docs/parser.md.';
  validateTask(task);
  validateTask("x".repeat(128000));
  for (const invalid of [undefined, null, {}, [], 42, "", " \n\t"]) {
    assert.throws(() => validateTask(invalid), /nonempty string/);
  }
  assert.throws(() => validateTask("x".repeat(128001)), /128KB/);
  assert.throws(() => validateTask("한".repeat(42667)), /128KB/);
});

async function runFake(script, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "subagents-test-"));
  try {
    return await runChild({ agent, task: "Task via stdin", cwd: root, runsDir: root, transport: "json",
      extensionPath: "/unused.ts", command: process.execPath,
      prefix: ["-e", script, "--"], killGraceMs: 50, ...options });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("JSON result, stdin task and usage (no model calls)", async () => {
  const result = await runFake(`
    let task = "";
    process.stdin.on("data", x => task += x);
    process.stdin.on("end", () => { console.log(JSON.stringify({
      type:"message_end", message:{role:"assistant", content:[{type:"text",text:task}],
      stopReason:"stop", usage:{input:7,output:3,totalTokens:10,cost:{total:0.1}}}
    })); console.log(JSON.stringify({type:"worker_task_done",report:task})); });
  `);
  assert.equal(result.status, "completed");
  assert.equal(result.output, "Task via stdin");
  assert.equal(result.usage.totalTokens, 10);
  assert.equal(result.usage.cost.total, 0.1);
});

test("missing output and nonzero exit are failures", async () => {
  assert.equal((await runFake("process.exit(0)")).status, "failed");
  assert.equal((await runFake("process.exit(2)")).status, "failed");
});

test("child tool events reach parent progress and retained activity", async () => {
  const progress = [];
  const result = await runFake(`
    console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"r",toolName:"read",args:{path:"src/main.ts"}}));
    console.log(JSON.stringify({type:"tool_execution_end",toolCallId:"r",isError:false}));
    console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"Done"}],stopReason:"stop"}}));
    console.log(JSON.stringify({type:"worker_task_done",report:"Done"}));
  `, { onProgress: p => progress.push(p) });
  assert.equal(result.status, "completed");
  assert.ok(progress.some(p => p.activity === "read"));
  assert.equal(progress.at(-1).activity, "read");
  assert.deepEqual(result.recent, ["read"]);
  assert.ok(result.elapsedMs >= 0);
});

test("four independent workers overlap; cancelling one leaves the others running", async () => {
  const controller = new AbortController();
  const started = new Set();
  const all = Array.from({ length: 4 }, (_, index) => runFake(`
    console.log(JSON.stringify({type:"tool_execution_update",toolName:"delegate",partialResult:{details:{ready:true}}}));
    setTimeout(() => {
      console.log(JSON.stringify({type:"message_end",
        message:{role:"assistant",content:[{type:"text",text:"done"}],stopReason:"stop"}}));
      console.log(JSON.stringify({type:"worker_task_done",report:"done"}));
    }, 250);
  `, {
    signal: index === 0 ? controller.signal : undefined,
    onDescendant: () => {
      started.add(index);
      if (started.size === 4) controller.abort();
    },
  }));
  const results = await Promise.all(all);
  assert.equal(started.size, 4);
  assert.equal(results[0].status, "cancelled");
  assert.deepEqual(results.slice(1).map(r => r.status), ["completed", "completed", "completed"]);
});

test("nested progress relays separately from final usage accounting", async () => {
  const updates = [];
  const result = await runFake(`
    console.log(JSON.stringify({type:"tool_execution_update",toolName:"delegate",partialResult:{details:{runId:"child",usage:{cost:{total:999}}}}}));
    console.log(JSON.stringify({type:"message_end",message:{role:"toolResult",usage:{input:2,output:3,cost:{total:0.2}}}}));
    console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}],
      stopReason:"stop",usage:{input:1,output:1,cost:{total:0.1}}}}));
    console.log(JSON.stringify({type:"worker_task_done",report:"done"}));
  `, { onDescendant: info => updates.push(info) });
  assert.equal(updates.length, 1);
  assert.ok(Math.abs(result.usage.cost.total - 0.3) < 1e-9);
  assert.equal(result.usage.input, 3);
});

test("native delegate progress carries live and terminal ancestry, bounded to 256 descendants", () => {
  const child = { runId: "child", parentRunId: "parent", status: "running" };
  const details = { runId: "parent", descendants: [child] };
  assert.deepEqual(descendantProgress({ type: "tool_execution_update", toolName: "delegate",
    partialResult: { details } }), [details, child]);
  const completed = { ...details, status: "completed" };
  assert.deepEqual(descendantProgress({ type: "tool_execution_end", toolName: "delegate",
    result: { details: completed } }), [completed, child]);
  assert.deepEqual(descendantProgress({ type: "tool_execution_update", toolName: "bash",
    partialResult: { details } }), []);
  assert.deepEqual(descendantProgress({ type: "tool_execution_end", toolName: "delegate", result: {} }), []);
  assert.equal(descendantProgress({ type: "tool_execution_update", toolName: "delegate",
    partialResult: { details: { descendants: Array(300).fill(child) } } }).length, 257);
});

test("workers receive explicit ticket mode independently of tool permissions", async () => {
  for (const ticketsEnabled of [false, true]) {
    const result = await runFake(`
      console.log(JSON.stringify({type:"worker_task_done",report:process.env.PI_SUBAGENT_TICKETS}));
    `, { ticketsEnabled });
    assert.equal(result.status, "completed");
    assert.equal(result.output, ticketsEnabled ? "on" : "off");
  }
});

test("maximum-depth child gets inherited limits but no delegate tool", async () => {
  const result = await runFake(`
    const at=process.argv.indexOf("--tools");
    const report=JSON.stringify({tools:process.argv[at+1],expected:JSON.parse(process.env.PI_SUBAGENT_TOOLS),
      depth:process.env.PI_SUBAGENT_DEPTH,limits:JSON.parse(process.env.PI_SUBAGENT_LIMITS),pool:process.env.PI_SUBAGENT_POOL});
    console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{
      type:"text",text:report
    }]}}));
    console.log(JSON.stringify({type:"worker_task_done",report}));
  `, { agent: { ...agent, can_delegate: true, delegatable_agents: ["worker"] }, depth: 1, pool: "/shared/pool",
    limits: { max_depth: 2, max_parallel: 16 } });
  const data = JSON.parse(result.output);
  assert.equal(result.status, "completed");
  assert.equal(data.depth, "2");
  assert.equal(data.tools, "read,bash,finish_task");
  assert.deepEqual(data.expected, ["read", "bash", "finish_task"]);
  assert.equal(data.pool, "/shared/pool");
  assert.deepEqual(data.limits, { max_depth: 2, max_parallel: 16, max_children: 3, max_nested_children: 1 });
});

test("top-level cancellation kills an inherited nested process group", {
  skip: process.platform === "win32",
}, async () => {
  const controller = new AbortController();
  let pid;
  const result = await runFake(`
    const {spawn}=require("node:child_process");
    const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},100)"],
      {detached:false,stdio:"ignore"});
    console.log(JSON.stringify({type:"tool_execution_update",toolName:"delegate",partialResult:{details:{pid:child.pid}}}));
    process.on("SIGTERM",()=>{});
    setInterval(()=>{},100);
  `, { signal: controller.signal, onDescendant: info => { pid = info.pid; controller.abort(); } });
  assert.equal(result.status, "cancelled");
  assert.ok(pid);
  await new Promise(resolve => setTimeout(resolve, 50));
  const check = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  assert.ok(!check.error, check.error?.message);
  assert.ok(!check.stdout.trim() || check.stdout.trim().startsWith("Z"), `Nested process still active: ${check.stdout}`);
});

test("explicit cancellation kills a TERM-resistant child after kill grace", async () => {
  const controller = new AbortController();
  const cancel = setTimeout(() => controller.abort(), 200);
  try {
    const result = await runFake('process.on("SIGTERM",()=>{});setInterval(()=>{},100);',
      { signal: controller.signal });
    assert.equal(result.error, "cancelled");
    assert.equal(result.status, "cancelled");
  } finally {
    clearTimeout(cancel);
  }
});

test("abort and oversized output stop the child", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    assert.equal((await runFake("setInterval(()=>{},100)", { signal: controller.signal })).error, "cancelled");
  } finally { clearTimeout(timer); }
  assert.equal((await runFake('console.log("x".repeat(2000))', { maxOutputBytes: 1000 })).error, "Output limit reached");
});
