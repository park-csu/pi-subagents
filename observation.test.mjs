import test from "node:test";
import assert from "node:assert/strict";
import { observationSnapshot } from "./observation.ts";
import { workerPreview, workerTree } from "./activity.ts";
import { WorkerStates } from "./state.ts";

const runId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

test("quiet telemetry keeps its observation and work status without an age threshold", () => {
  const worker = { runId, agent: "researcher", status: "running", activity: "bash",
    observation: { state: "current", lastEventAt: 1000 } };
  assert.equal(observationSnapshot(worker.observation, 1001).state, "current");
  const now = 1000 + 24 * 60 * 60 * 1000;
  assert.equal(observationSnapshot(worker.observation, now).state, "current");
  const lines = workerTree([worker], { now });
  assert.match(lines[0], /^[◐⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] researcher/);
  assert.match(lines[0], / · bash$/);
  assert.equal(worker.status, "running");
  assert.equal(worker.observation.state, "current", "rendering does not mutate execution state");
  worker.observation.lastEventAt = now;
  assert.match(workerTree([worker], { now })[0], / · bash$/);
});

test("invalid observations do not change work status or overwrite the report", () => {
  const states = new WorkerStates();
  const worker = { runId, agent: "researcher", status: "completed", output: "Verified output" };
  states.update(worker);
  const preview = workerPreview({ ...worker, observation: { state: "bogus", lastEventAt: Infinity } });
  states.update(preview);
  assert.equal(states.tree(worker).status, "completed");
  assert.equal(states.tree(worker).output, "Verified output");
  assert.equal(preview.observation.state, "invalid");
  assert.equal(workerPreview({ runId, observation: { state: "current", lastEventAt: 1 } }), undefined);
  assert.equal(workerPreview({ runId, status: "bogus" }), undefined);
  assert.equal(observationSnapshot(undefined).state, "unseen");
  assert.equal(workerPreview({ ...worker, observation: { state: "current", lastEventAt: 1 },
    output: "SECRET" }).output, undefined);
});
