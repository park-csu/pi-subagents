import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContract, contractMarkdown } from './contract.ts';
const task = { objective: 'Fix auth', scope: { read: ['src/auth.ts'], write: ['src/auth.ts'] },
  plan: ['Inspect failure', 'Fix and verify'], acceptance: ['Regression test passes'] };
test('execution contract rejects missing/unknown fields, blank checks and ambiguous write paths', () => {
  assert.deepEqual(validateContract(task), task);
  for (const value of ['Fix auth', {...task, acceptance: []}, {...task, acceptance: [' ']},
    {...task, unexpected: true}, {...task, scope: {read: [], write: ['src/**']}}]) {
    assert.throws(() => validateContract(value));
  }
  const copy = validateContract(task); copy.plan.push('Other'); assert.equal(task.plan.length, 2);
});
test('Markdown presents owned scope, numbered plan and acceptance without serializing JSON', () => {
  const rendered = contractMarkdown(task);
  assert.match(rendered, /\*\*Write scope\*\*/);
  assert.match(rendered, /1\. Inspect failure/);
  assert.match(rendered, /Regression test passes/);
  assert.doesNotMatch(rendered, /"objective"/);
  assert.match(contractMarkdown({...task, scope:{read:[],write:[]}}), /Read-only/);
  assert.doesNotThrow(() => contractMarkdown({}));
});
