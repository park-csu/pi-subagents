import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("compaction is not user pause; manual active work resumes but explicit Escape does not", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-compaction-"));
  const handoff = join(root, "handoff.txt");
  await writeFile(handoff, "task");
  const source = `
    import assert from 'node:assert/strict';
    import {installTerminalBridge} from ${JSON.stringify(new URL("./terminal.ts", import.meta.url).href)};
    const hooks=new Map(),bus=new Map(); let prompts=0,shutdowns=0;
    const ctx={mode:'tui',ui:{setEditorText(){}},isIdle:()=>true,signal:undefined,
      shutdown:()=>shutdowns++,abort(){}};
    const fire=(name,data={})=>{for(const fn of hooks.get(name)||[])fn(data,ctx)};
    const pi={on:(name,fn)=>{if(!hooks.has(name))hooks.set(name,[]);hooks.get(name).push(fn)},
      events:{on:(name,fn)=>{bus.set(name,fn);return ()=>bus.delete(name)},emit:(name,x)=>bus.get(name)?.(x)},
      sendUserMessage:()=>{prompts++;fire('agent_start')}};
    installTerminalBridge(pi,{PI_SUBAGENT_TUI:'1',PI_SUBAGENT_HANDOFF:${JSON.stringify(handoff)}});
    const tick=()=>new Promise(r=>setTimeout(r,10));
    fire('session_start'); await tick();
    const aborted=()=>fire('message_end',{message:{role:'assistant',stopReason:'aborted'}});
    // Native automatic recovery owns its retry: no pause or duplicate prompt.
    fire('session_before_compact',{reason:'overflow',willRetry:true});
    aborted(); fire('agent_end'); fire('agent_settled');
    assert.equal(shutdowns,0);
    fire('session_compact',{reason:'overflow',willRetry:true}); await tick();
    assert.equal(prompts,1);
    fire('agent_start');
    // Manual compaction can abort before the public before-compact hook.
    aborted(); fire('agent_settled');
    fire('session_before_compact',{reason:'manual'});
    fire('session_compact',{reason:'manual'}); await tick();
    assert.equal(prompts,2,'interrupted work continues after the compaction lock clears');
    // Explicit Escape followed by manual compaction must stay paused.
    pi.events.emit('subagents:user-interrupt',{});
    aborted(); fire('agent_settled');
    fire('session_before_compact',{reason:'manual'});
    fire('session_compact',{reason:'manual'}); await tick();
    assert.equal(prompts,2);
    // Failed compaction cannot synthesize another model turn.
    fire('agent_start');
    fire('session_before_compact',{reason:'threshold'});
    fire('session_compact_failed',{reason:'threshold',errorMessage:'fixture failure'});
    await tick(); assert.equal(prompts,2);
    fire('session_shutdown'); process.exit(0);
  `;
  let child;
  try {
    child = spawn(process.execPath, ["--input-type=module", "-e", source],
      { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    let wire = "", stderr = "";
    child.stdio[3].on("data", chunk => { wire += chunk; });
    child.stdio[4].resume();
    child.stderr.on("data", chunk => { stderr += chunk; });
    assert.equal(await new Promise(resolve => child.on("close", resolve)), 0, stderr);
    const events = wire.trim().split("\n").map(line => JSON.parse(line));
    const automaticEnd = events.findIndex(e => e.type === "worker_compaction" && e.phase === "completed");
    assert.ok(automaticEnd >= 0);
    assert.ok(!events.slice(0, automaticEnd).some(e => e.type === "worker_paused"));
    // One manual-compaction continuation, plus the explicit agent_start used
    // to begin the final failure scenario after the user's paused session.
    assert.equal(events.filter(e => e.type === "worker_resumed").length, 2);
    assert.equal(events.find(e => e.type === "worker_compaction" && e.phase === "failed").error, "fixture failure");
  } finally {
    child?.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
