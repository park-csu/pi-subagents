import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workflowContext } from "./workflow.ts";

test("primary-agent duties and optional delegation are scoped to depth zero", () => {
  const root = workflowContext(0);
  assert.match(root, /You are the primary agent/);
  assert.match(root, /may perform all of the work yourself/);
  assert.match(root, /Handle the request directly; delegate bounded work when useful/);
  assert.match(root, /No job or phase requires a subagent/);
  assert.match(root, /acceptance checks independently/);
  assert.match(root, /direct-execution or diagnosis-only/);
  for (const depth of [1, 2, 8]) {
    const worker = workflowContext(depth);
    assert.match(worker, new RegExp(`worker \\(depth ${depth}\\)`));
    assert.match(worker, /Your parent is the session that assigned your task/);
    assert.doesNotMatch(worker, /You are the primary agent|Handle the request directly|Inspect actual changes and run/);
    assert.match(worker, /Only delegate if your role and available tools permit it/);
  }
});

test("ticket workflow is task-scoped and keeps parent acceptance ownership", () => {
  const root = workflowContext(0, true);
  assert.match(root, /one ticket folder per independently verifiable implementation task, not per model call or session/);
  assert.match(root, /tickets\/<id>-<slug>\/\{task\.md,plan\.md,notes\.md\}/);
  assert.match(root, /Respect an existing project ticket convention/);
  assert.match(root, /Simple answers and read-only lookups need no new ticket/);
  assert.match(root, /Pass the absolute ticket folder/);
  assert.match(root, /files are not automatically loaded/);
  assert.match(root, /done only after independent acceptance verification/);
  assert.match(root, /No automatic branch, commit, PR or session split/);
});

test("workers reuse tickets without expanding read-only permissions or sharing writers", () => {
  for (const depth of [1, 2, 8]) {
    const worker = workflowContext(depth, true);
    assert.match(worker, /read its task\.md, plan\.md and notes\.md before work and on continuation/);
    assert.match(worker, /a call, retry, or helper investigation is not a new ticket/);
    assert.match(worker, /sole writer and your role permits file edits/);
    assert.match(worker, /otherwise return findings for the owner to record/);
    assert.match(worker, /Never broaden scope or mark the ticket done yourself/);
    assert.match(worker, /Helpers must not overwrite their caller's ledger/);
    assert.doesNotMatch(worker, /Before implementation, create or reuse/);
  }
});

test("ticket mode defaults off without removing scope, verification or lifecycle duties", () => {
  for (const depth of [0, 1, 2]) {
    const prompt = workflowContext(depth);
    assert.match(prompt, /Ticket workflow: OFF/);
    assert.match(prompt, /Preserve existing tickets/);
    assert.doesNotMatch(prompt, /Before implementation, create or reuse|When assigned a ticket folder|sole writer/);
    if (depth === 0) {
      assert.match(prompt, /acceptance checks independently/);
      assert.match(prompt, /Keep parallel writes disjoint/);
    } else {
      assert.match(prompt, /Never broaden scope or edit files outside your assigned permissions/);
      assert.match(prompt, /call finish_task alone/);
    }
  }
});

test("ticket templates separate contract, plan and evidence without claiming checks ran", () => {
  const template = name => readFileSync(new URL(`../../tickets/_template/${name}.md`, import.meta.url), "utf8");
  const task = template("task");
  for (const field of ["id:", "status: todo", "dependencies: []", "## Acceptance criteria", "## Verification", "## Out of scope"]) {
    assert.ok(task.includes(field), field);
  }
  assert.match(task, /Ledger writer/);
  assert.match(template("plan"), /## Steps/);
  assert.match(template("notes"), /No checks run yet/);
  assert.match(template("notes"), /## Unresolved issues/);
});
