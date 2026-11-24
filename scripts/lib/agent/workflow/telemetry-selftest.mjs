// Issue #4482 SC-07 fixtures: the Reconcile observation is source-correlated,
// bounded and free of prompts/native session bytes/credentials.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLifecycleState } from './contract.mjs';
import { buildReconcileTelemetry, validateReconcileTelemetry } from './telemetry.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const BASE = 'a'.repeat(40);
const state = createLifecycleState({
  registry, issue: 4482, base_sha: BASE,
  developer: 'dev-cursor-01', reviewer: 'review-cursor-01',
  acceptor: 'accept-cursor-01', developer_sha: BASE,
  authority: {
    repository: 'BestNathan/nession', event: 'workflow_dispatch',
    permission: 'write', ref: 'refs/heads/main', run_id: 9001,
  },
  now: 1000,
});
const withCheckpoint = {
  ...state,
  thread: {
    ...state.thread,
    checkpoint: {
      version: 3, commit_sha: '1'.repeat(40),
      ciphertext_sha256: '2'.repeat(64), native_session_id: 'private-native-id',
    },
  },
  budgets: { infrastructure_retries: 1, model_retries: 2, repair_rounds: 1 },
  feedback: {
    bundle_sha256: '3'.repeat(64), head_sha: BASE,
    ci_digest: null, review_digest: null, parent_sha256: null,
    repair_round: 1, finding_ids: ['review:R-2'], sources: ['review'],
  },
};
const summary = {
  schema_version: 1,
  kind: 'agent_workflow_v2_reconcile_result',
  issue: 4482,
  wake: { source: 'schedule', reason: 'five_minute_scan' },
  steps: [
    { decision: 'advance', reason: 'developer_retry' },
    { decision: 'stale_observation', reason: 'reload_and_reobserve' },
  ],
  store_version: 7,
  phase: 'developing',
  decision: 'advance',
  reason: 'developer_retry',
  migrated: true,
  exhausted: false,
};
const record = buildReconcileTelemetry({
  summary, state: withCheckpoint, now: 4000,
});
validateReconcileTelemetry(record);
assert.equal(record.kind, 'agent_workflow_reconcile_observation');
assert.equal(record.issue, 4482);
assert.equal(record.wake.source, 'schedule');
assert.equal(record.phase, 'authorized');
assert.equal(record.store_version, 7);
assert.equal(record.migrated, true);
assert.equal(record.pending_actions, 1);
assert.equal(record.unresolved_dispatch, 0);
assert.equal(record.retry_budget.infrastructure, 1);
assert.equal(record.retry_budget.model, 2);
assert.equal(record.repair_round, 1);
assert.equal(record.first_pass, false);
assert.equal(record.stage_age_ms, 3000);
assert.equal(record.checkpoint.version, 3);
assert.equal(record.checkpoint.session_bound, true);
assert.equal(record.feedback_finding_count, 1);
assert.equal(record.stale_results, 1);
assert.equal(record.ingest_failures, 0);

const serialized = JSON.stringify(record);
assert.ok(!serialized.includes('private-native-id'),
  'native session identity is not published');
assert.ok(!serialized.includes('"native_bytes"'));
assert.ok(!serialized.includes('plaintext'));
assert.ok(Buffer.byteLength(serialized) < 16 * 1024);

// Only bounded snake_case step reasons are admitted, so a raw error log or
// prompt fragment cannot be smuggled into published telemetry.
assert.throws(() => buildReconcileTelemetry({
  summary: {
    ...summary,
    steps: [{ decision: 'recover', reason: 'native_bytes=AAAA plaintext session' }],
  },
  state, now: 4000,
}), /invalid step reason/);
assert.throws(() => buildReconcileTelemetry({
  summary: { ...summary, issue: 4483 }, state, now: 4000,
}), /does not belong/);
assert.throws(() => buildReconcileTelemetry({
  summary: { ...summary, decision: 'invalid decision with spaces' }, state, now: 4000,
}), /invalid decision/);
assert.throws(() => buildReconcileTelemetry({
  summary: { ...summary, steps: new Array(33).fill({ decision: 'wait' }) },
  state, now: 4000,
}), /invalid reconcile steps/);

console.log('agent workflow telemetry selftest: OK');
