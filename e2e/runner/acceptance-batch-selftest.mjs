#!/usr/bin/env node
// #1866 Phase B isolation contract: who may share a job-scoped runtime.
//
// The default must be isolation. Sharing is a claim about mutable state, so a
// Case that does not opt in, an unknown Case, or a profile mismatch must each
// fall back to a fresh runtime rather than joining a batch.
import assert from 'node:assert/strict';
import { planAcceptanceBatches } from './acceptance-batch.mjs';

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

console.log('acceptance batch isolation: opt-in sharing, isolated default, ' +
  'profile mismatch and unknown-Case fallbacks passed');
