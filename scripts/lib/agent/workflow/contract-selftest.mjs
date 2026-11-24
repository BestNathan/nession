// Issue #4482 SC-01/SC-05 contract fixtures: strict schema v2 validation,
// deterministic Thread/action identity, immutable Store CAS and tamper
// rejection.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  actionIdFor, createLifecycleState, evidenceGenerationFor, threadIdFor,
  transitionKey, validateLifecycleState,
} from './contract.mjs';
import {
  issueStatePath, readIssueWorkflowState, writeIssueWorkflowState,
} from '../orchestration/state-store.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const BASE = 'a'.repeat(40);
const authority = {
  repository: 'BestNathan/nession', event: 'workflow_dispatch',
  permission: 'write', ref: 'refs/heads/main', run_id: 9001,
};
function fresh(overrides = {}) {
  return createLifecycleState({
    registry, issue: 4482, base_sha: BASE,
    developer: 'dev-cursor-01', reviewer: 'review-cursor-01',
    acceptor: 'accept-cursor-01', developer_sha: BASE,
    authority, now: 1000, ...overrides,
  });
}

const state = fresh();
assert.equal(state.schema_version, 2);
assert.equal(state.phase, 'authorized');
assert.equal(state.thread.fencing_generation, 1);
assert.equal(state.outbox.length, 1);
assert.equal(state.outbox[0].status, 'pending');

// Deterministic Thread/action/evidence identities.
assert.equal(
  threadIdFor({ issue: 4482, developer: 'dev-cursor-01', base_sha: BASE }),
  state.thread.id);
assert.equal(
  threadIdFor({ issue: 4482, developer: 'dev-cursor-01', base_sha: BASE }),
  threadIdFor({ issue: 4482, developer: 'dev-cursor-01', base_sha: BASE }));
assert.notEqual(
  threadIdFor({ issue: 4482, developer: 'dev-cursor-01', base_sha: BASE }),
  threadIdFor({ issue: 4483, developer: 'dev-cursor-01', base_sha: BASE }));
const actionId = actionIdFor({
  issue: 4482, thread_id: state.thread.id, role: 'developer',
  action: 'implement', sha: BASE, ordinal: 1,
});
assert.equal(actionId, state.outbox[0].id);
assert.equal(actionId, actionIdFor({
  issue: 4482, thread_id: state.thread.id, role: 'developer',
  action: 'implement', sha: BASE, ordinal: 1,
}));
assert.notEqual(actionId, actionIdFor({
  issue: 4482, thread_id: state.thread.id, role: 'developer',
  action: 'implement', sha: BASE, ordinal: 2,
}));
const generation = evidenceGenerationFor({ head_sha: BASE, ci_digest: 'b'.repeat(64) });
assert.match(generation, /^[a-f0-9]{64}$/);
assert.notEqual(generation, evidenceGenerationFor({
  head_sha: BASE, ci_digest: 'c'.repeat(64),
}));

// Strict negative validation.
const negative = [
  { ...state, schema_version: 1 },
  { ...state, extra: true },
  { ...state, phase: 'unknown' },
  { ...state, assignments: { ...state.assignments, reviewer: 'not a role' } },
  { ...state, block_reason: 'x' },
  { ...state, thread: { ...state.thread, fencing_generation: 0 } },
  { ...state, thread: { ...state.thread, checkpoint: {
    version: 1, commit_sha: BASE, ciphertext_sha256: 'a'.repeat(64),
    native_session_id: 'n', native_bytes: 'plaintext',
  } } },
  { ...state, thread: { ...state.thread, checkpoint: {
    version: 1, commit_sha: BASE, ciphertext_sha256: 'a'.repeat(64),
    native_session_id: 'n', writer_token: 'ghs_secret',
  } } },
  { ...state, writer_token: 'ghs_secret' },
  { ...state, outbox: [...state.outbox, { ...state.outbox[0], id: 'b'.repeat(64) }] },
  { ...state, outbox: [{ ...state.outbox[0], agent_id: 'review-cursor-01' }] },
  { ...state, outbox: [{ ...state.outbox[0], status: 'failed' }] },
  { ...state, transitions: [
    { key: 'a'.repeat(64), kind: 'developer', outcome: 'x', recorded_version: 1 },
    { key: 'a'.repeat(64), kind: 'developer', outcome: 'x', recorded_version: 1 },
  ] },
  { ...state, budgets: { ...state.budgets, repair_rounds: -1 } },
  { ...state, phase: 'blocked' },
  { ...state, phase: 'cancelled' },
  { ...state, migration: { from_schema_version: 1, from_version: 1,
    from_digest: 'a'.repeat(64), from_phase: 'ready', mapped_phase: 'unknown',
    legacy_order: 'none' } },
];
for (const candidate of negative) {
  assert.throws(() => validateLifecycleState(candidate), /agent workflow v2|checkpoint binding/);
}

// Transition keys bind run, attempt, SHA, outcome and evidence generation.
const baseEvent = {
  issue: 4482, kind: 'reviewer', action_id: 'a'.repeat(64),
  run_id: 1, attempt: 1, target_sha: BASE, outcome: 'approved',
  evidence_generation: null,
};
assert.equal(transitionKey(baseEvent), transitionKey({ ...baseEvent }));
assert.notEqual(transitionKey(baseEvent), transitionKey({ ...baseEvent, outcome: 'changes_requested' }));
assert.notEqual(transitionKey(baseEvent), transitionKey({ ...baseEvent, attempt: 2 }));
assert.notEqual(transitionKey(baseEvent), transitionKey({
  ...baseEvent, evidence_generation: generation,
}));

// The versioned Store accepts a v2 state, is idempotent and rejects stale CAS.
const root = mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-v2-store-'));
try {
  const written = writeIssueWorkflowState(root, state, 0);
  assert.equal(written.changed, true);
  assert.equal(written.version, 1);
  const loaded = readIssueWorkflowState(root, 4482);
  assert.equal(loaded.version, 1);
  assert.equal(loaded.state.schema_version, 2);
  assert.deepEqual(loaded.state, state);
  assert.equal(writeIssueWorkflowState(root, state, 0).changed, false);
  assert.throws(() => writeIssueWorkflowState(root, {
    ...state, substate: 'changed',
  }, 0), /collision/);
  assert.throws(() => writeIssueWorkflowState(root, {
    ...state, version: 2, substate: 'next',
  }, 5), /stale workflow state CAS/);

  // Tampering with the immutable state is detected against the head digest.
  const file = path.join(root, issueStatePath(4482, 1));
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, original.replace('"authorized"', '"developing"'));
  assert.throws(() => readIssueWorkflowState(root, 4482), /digest mismatch/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('agent workflow contract selftest: OK');
