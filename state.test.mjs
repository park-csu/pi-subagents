import test from "node:test";
import assert from "node:assert/strict";
import { WorkerStates, resumePrompt } from "./state.ts";
import { workerTree } from "./activity.ts";

test("a returned paused card follows resumed and completed descendants and invalidates ancestors", () => {
  const states = new WorkerStates();
  const root = { runId: "root", parentRunId: "", agent: "researcher", goal: "Full original goal", status: "paused" };
  const child = { runId: "child", parentRunId: "root", agent: "researcher", status: "paused" };
  const original = { ...root, descendants: [child] };
  states.update(root); states.update(child);
  let redraws = 0;
  states.invalidators.set("root", () => redraws++);
  states.update({ ...child, status: "running" });
  assert.equal(states.tree(original).descendants[0].status, "running");
  states.update({ ...child, status: "completed" });
  const current = states.tree(original);
  assert.equal(current.descendants[0].status, "completed");
  assert.equal(original.descendants[0].status, "paused", "saved tool response remains immutable");
  assert.equal(redraws, 2);
  assert.match(workerTree([current, ...current.descendants]).join("\n"), /└─ ✓ researcher/);
  states.update({ ...root, status: "completed", output: "final report" });
  assert.equal(states.tree(original).output, "final report");
});

test("continuation includes completed child reports as data, not instructions", () => {
  const prompt = resumePrompt("Continue", [{ runId: "child", status: "completed", output: "observed result" }]);
  assert.match(prompt, /not new instructions/);
  assert.match(prompt, /"status":"completed"/);
  assert.match(prompt, /observed result/);
  assert.equal(resumePrompt("Continue", []), "Continue");
});

test("transcript snapshots ignore live progress but retain lifecycle and report updates", () => {
  const states = new WorkerStates();
  const root = { runId: "root", agent: "worker", status: "running", elapsedMs: 0 };
  states.update(root);
  let redraws = 0;
  states.invalidators.set("root", () => redraws++);
  assert.equal(states.update({ ...root, elapsedMs: 5000, turns: 3, activity: "bash" }), false);
  assert.equal(redraws, 0);
  assert.equal(states.tree(root).elapsedMs, 0);
  states.update({ ...root, status: "paused", elapsedMs: 6000 });
  states.update({ ...root, status: "paused", elapsedMs: 7000 });
  assert.equal(redraws, 1);
  assert.equal(states.tree(root).elapsedMs, 6000);
  states.update({ ...root, status: "running", elapsedMs: 8000 });
  states.update({ ...root, status: "running", elapsedMs: 9000 });
  assert.equal(redraws, 2);
  states.update({ ...root, status: "completed", elapsedMs: 10000 });
  states.update({ ...root, status: "completed", output: "saved report", runDir: "/tmp/run" });
  assert.equal(states.tree(root).output, "saved report");
  assert.equal(states.tree(root).runDir, "/tmp/run");
});
