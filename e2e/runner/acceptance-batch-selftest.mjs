#!/usr/bin/env node
// #1866 Phase B isolation contract: who may share a job-scoped runtime.
//
// The default must be isolation. Sharing is a claim about mutable state, so a
// Case that does not opt in, an unknown Case, or a profile mismatch must each
// fall back to a fresh runtime rather than joining a batch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeAcceptanceBatches, planAcceptanceBatches } from './acceptance-batch.mjs';

const manifests = new Map([
  ['1:SC-01', { runtime: 'full-stack-local', isolation: 'shared' }],
  ['2:SC-01', { runtime: 'full-stack-local', isolation: 'shared' }],
  ['3:SC-01', { runtime: 'full-stack-local', isolation: 'isolated' }],
  ['4:SC-01', { runtime: 'full-stack-local' }],
  ['5:SC-01', { runtime: 'other-profile', isolation: 'shared' }],
  ['6:SC-01', { runtime: 'full-stack-local', isolation: 'shared' }],
]);
const resolveManifest = (_root, entry) => {
  const manifest = manifests.get(entry.issue + ':' + entry.criterion);
  if (!manifest) throw new Error('unknown Case'); // exercises the fallback path
  return manifest;
};
const plan = (cases) => planAcceptanceBatches({ repoRoot: '.', cases, resolveManifest });
const shape = (batches) => batches.map((batch) => ({
  shared: batch.shared,
  profile: batch.profile,
  cases: batch.cases.map((entry) => entry.issue + '/' + entry.criterion),
}));

// Two opted-in Cases at one profile share ONE runtime.
assert.deepEqual(shape(plan([
  { issue: 1, criterion: 'SC-01' }, { issue: 2, criterion: 'SC-01' },
])), [{ shared: true, profile: 'full-stack-local', cases: ['1/SC-01', '2/SC-01'] }]);

// An isolated Case in the middle splits the run, and a group that ends up with
// a single Case is downgraded — sharing one stack for one Case saves nothing.
assert.deepEqual(shape(plan([
  { issue: 1, criterion: 'SC-01' }, { issue: 3, criterion: 'SC-01' },
  { issue: 2, criterion: 'SC-01' }, { issue: 6, criterion: 'SC-01' },
])), [
  { shared: false, profile: 'full-stack-local', cases: ['1/SC-01'] },
  { shared: false, profile: 'full-stack-local', cases: ['3/SC-01'] },
  { shared: true, profile: 'full-stack-local', cases: ['2/SC-01', '6/SC-01'] },
]);

// A Case that never declared isolation is treated exactly like `isolated`.
assert.deepEqual(shape(plan([{ issue: 4, criterion: 'SC-01' }])),
  [{ shared: false, profile: 'full-stack-local', cases: ['4/SC-01'] }]);

// A profile mismatch never shares, even when both opted in.
assert.deepEqual(shape(plan([
  { issue: 1, criterion: 'SC-01' }, { issue: 5, criterion: 'SC-01' },
])), [
  { shared: false, profile: 'full-stack-local', cases: ['1/SC-01'] },
  { shared: false, profile: 'other-profile', cases: ['5/SC-01'] },
]);

// An unknown Case falls back to isolation and carries no profile.
assert.deepEqual(shape(plan([{ issue: 99, criterion: 'SC-99' }])),
  [{ shared: false, profile: null, cases: ['99/SC-99'] }]);

// A one-Case "shared" batch saves nothing, so it stays isolated.
assert.equal(plan([{ issue: 1, criterion: 'SC-01' }])[0].shared, false);

// An empty selection is an error, never a silent no-op.
assert.throws(() => plan([]), /at least one Case/);
assert.throws(() => planAcceptanceBatches({ repoRoot: '.' }), /at least one Case/);

// --- execution: one runtime for a shared batch, and failures never suppress
// other batches' evidence (SC-06).
const contractsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-batch-contracts-'));
const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-batch-results-'));
try {
  for (const issue of [1, 2, 3, 7]) {
    fs.writeFileSync(path.join(contractsDir, issue + '.json'),
      JSON.stringify({ number: issue, body: '' }));
  }
  const record = (opts) => ({
    issue: opts.issueNumber, criterion: opts.criterion, result: 'Pass',
    runtime_profile: 'full-stack-local', execution_id: String(opts.issueNumber).repeat(64).slice(0, 64),
    contract_sha256: 'c'.repeat(64), case_tree_sha: 'a'.repeat(40),
  });
  const run = (batches, options = {}) => executeAcceptanceBatches({
    repoRoot: '.', batches, stage: 'post-merge', targetSha: 'a'.repeat(40),
    runId: 9, runAttempt: 1, resultsDir, contractsDir, ...options,
  });

  // Two opted-in Cases receive the SAME runtime object; an isolated Case does
  // not, and the shared runtime is stopped exactly once.
  const seen = [];
  let stops = 0;
  const runtime = { stop: async () => { stops += 1; } };
  const sharedPlan = plan([{ issue: 1, criterion: 'SC-01' },
    { issue: 2, criterion: 'SC-01' }, { issue: 3, criterion: 'SC-01' }]);
  const shared = await run(sharedPlan, {
    runtimeFactory: async () => runtime,
    runCaseImpl: async (opts) => { seen.push(opts.runtime); return record(opts); },
  });
  assert.equal(shared.records.length, 3);
  assert.equal(shared.errors.length, 0);
  assert.equal(shared.sharedRuntimeCount, 1);
  assert.equal(seen[0], runtime);
  assert.equal(seen[1], runtime);
  assert.equal(seen[2], null);
  assert.equal(stops, 1);

  // A shared runtime that cannot start is an error for that batch only; the
  // following isolated Case still produces its own record.
  const failedPlan = plan([{ issue: 1, criterion: 'SC-01' },
    { issue: 2, criterion: 'SC-01' }, { issue: 7, criterion: 'SC-01' }]);
  const survived = await run(failedPlan, {
    runtimeFactory: async () => { throw new Error('stack unavailable'); },
    runCaseImpl: async (opts) => record(opts),
  });
  assert.equal(survived.records.length, 1);
  assert.equal(survived.records[0].issue, 7);
  assert.equal(survived.errors.length, 2);
  assert.deepEqual(survived.errors.map((error) => error.issue), [1, 2]);
  assert.match(survived.errors[0].message, /batch runtime: stack unavailable/);
  assert.equal(survived.sharedRuntimeCount, 0);

  // A teardown failure is reported but never hides the records already made.
  const teardown = await run(
    plan([{ issue: 1, criterion: 'SC-01' }, { issue: 2, criterion: 'SC-01' }]), {
      runtimeFactory: async () => ({ stop: async () => { throw new Error('busy'); } }),
      runCaseImpl: async (opts) => record(opts),
      log: () => {},
    });
  assert.equal(teardown.records.length, 2);
} finally {
  fs.rmSync(contractsDir, { recursive: true, force: true });
  fs.rmSync(resultsDir, { recursive: true, force: true });
}

console.log('acceptance batch isolation: opt-in sharing, isolated default, ' +
  'profile mismatch, unknown-Case and batch-failure fallbacks passed');
