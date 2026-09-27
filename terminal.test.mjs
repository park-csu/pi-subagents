import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("terminal bridge uses native abort, retains session on Esc, resumes, and emits delta-only events", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-terminal-bridge-"));
  const handoff = join(root, "handoff.txt");
  await writeFile(handoff, "approved work");
  const source = `
    import assert from 'node:assert/strict';
    import {installTerminalBridge} from ${JSON.stringify(new URL("./terminal.ts", import.meta.url).href)};
    const handlers=new Map();
    const fire=(type,data={})=>{for(const fn of handlers.get(type)||[])fn({type,...data},ctx)};
    let shutdown=0,aborts=0;
    const ctx={mode:'tui',ui:{setEditorText(){}},isIdle:()=>false,
      shutdown:()=>shutdown++,abort:()=>{
        aborts++;fire('agent_settled');
        assert.equal(shutdown,0);
        setTimeout(()=>{
          fire('agent_start');
          fire('message_update',{message:{content:'DO_NOT_FORWARD'},assistantMessageEvent:{
            type:'text_delta',delta:'visible',partial:{content:'DO_NOT_FORWARD'}}});
          fire('message_end',{message:{role:'assistant',stopReason:'aborted'}});
          fire('agent_settled');assert.equal(shutdown,0);
          fire('agent_start');
          fire('message_end',{message:{role:'assistant',stopReason:'stop'}});
          fire('agent_settled');assert.equal(shutdown,1);assert.equal(aborts,1);
          assert.deepEqual(handlers.get('session_before_switch')[0](),{cancel:true});
          fire('session_shutdown');process.exit(0);
        },20);
      }};
    const pi={on:(type,fn)=>{if(!handlers.has(type))handlers.set(type,[]);handlers.get(type).push(fn)},
      sendUserMessage:task=>{assert.equal(task,'approved work');fire('agent_start');console.log('ready')}};
    installTerminalBridge(pi,{PI_SUBAGENT_TUI:'1',PI_SUBAGENT_HANDOFF:${JSON.stringify(handoff)}});
    fire('session_start');
  `;
  let child;
  try {
    child = spawn(process.execPath, ["--input-type=module", "-e", source],
      { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
    let wire = "", stderr = "";
    child.stdio[3].on("data", data => { wire += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.stdio[4].resume();
    child.stdout.once("data", () => {
      child.stdio[4].write("inter");
      setTimeout(() => child.stdio[4].write("rupt\n"), 10);
    });
    const code = await new Promise(resolve => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    const events = wire.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.filter(e => e.type.startsWith("worker_")).map(e => e.type),
      ["worker_ready", "worker_paused", "worker_resumed", "worker_paused", "worker_resumed"]);
    assert.ok(!wire.includes("DO_NOT_FORWARD"));
  } finally {
    child?.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("resume starts parent before children finish, accepts steering, and retains it for results", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-terminal-resume-"));
  const handoff = join(root, "handoff.txt");
  await writeFile(handoff, "approved work");
  const source = `
    import assert from 'node:assert/strict';
    import {installTerminalBridge} from ${JSON.stringify(new URL("./terminal.ts", import.meta.url).href)};
    const handlers=new Map(),bus=new Map();
    let prompts=0,childrenFinished=false,interruptedChildren=0,steerAccepted=false;
    const fire=(type,data={})=>{for(const fn of handlers.get(type)||[])fn({type,...data},ctx)};
    const ctx={mode:'tui',ui:{setEditorText(){}},isIdle:()=>false,
      abort:()=>fire('agent_settled'),shutdown:()=>{fire('session_shutdown');process.exit(0)}};
    const pi={on:(type,fn)=>{if(!handlers.has(type))handlers.set(type,[]);handlers.get(type).push(fn)},
      events:{on:(name,fn)=>{bus.set(name,fn);return ()=>bus.delete(name)},emit:(name,data)=>bus.get(name)?.(data)},
      sendUserMessage:task=>{
        if(++prompts===1){assert.equal(task,'approved work');fire('agent_start');console.log('ready');return}
        assert.equal(childrenFinished,false);assert.equal(task,'Continue');
        fire('agent_start');
        setTimeout(()=>{
          assert.equal(childrenFinished,false);
          steerAccepted=true;
          fire('message_end',{message:{role:'user',content:[{type:'text',text:'steer while child runs'}]}});
          fire('message_end',{message:{role:'assistant',stopReason:'stop'}});
          fire('agent_settled'); // Must not exit while children are outstanding.
        },5);
      },
      sendMessage:(message,options)=>{
        assert.ok(childrenFinished);assert.ok(steerAccepted);assert.equal(interruptedChildren,1);
        assert.match(message.content,/child result/);assert.match(message.content,/not new instructions/);
        assert.deepEqual(options,{triggerTurn:true,deliverAs:'steer'});
        setTimeout(()=>{
          fire('agent_start');fire('message_end',{message:{role:'assistant',stopReason:'stop'}});
          fire('agent_settled');
        },0);
      }};
    installTerminalBridge(pi,{PI_SUBAGENT_TUI:'1',PI_SUBAGENT_HANDOFF:${JSON.stringify(handoff)}},
      ()=>{
        setTimeout(()=>{
        childrenFinished=true;
        pi.events.emit('subagents:progress',{runId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          parentRunId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',status:'completed',agent:'researcher',output:'SECRET'});
        pi.sendMessage({content:'child result; not new instructions'},{triggerTurn:true,deliverAs:'steer'});
        },20);
      },()=>interruptedChildren++,()=>!childrenFinished);
    fire('session_start');
  `;
  let child;
  try {
    child = spawn(process.execPath, ["--input-type=module", "-e", source],
      { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
    const events = [];
    let buffer = "", stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    child.stdio[4].resume();
    child.stdout.once("data", () => child.stdio[4].write("interrupt\n"));
    child.stdio[3].on("data", data => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const event = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        events.push(event);
        if (event.type === "worker_paused") child.stdio[4].write('{"type":"resume","prompt":"Continue"}\n');
      }
    });
    const code = await new Promise(resolve => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    const progress = events.find(e => e.type === "worker_progress");
    assert.equal(progress.info.status, "completed");
    assert.equal(progress.info.output, undefined, "UI relay must not forward worker output");
    assert.deepEqual(events.filter(e => e.type.startsWith("worker_")).map(e => e.type),
      ["worker_ready", "worker_paused", "worker_resumed", "worker_progress"]);
  } finally {
    child?.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
