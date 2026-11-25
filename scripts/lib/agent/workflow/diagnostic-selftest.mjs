// Issue #4525 SC-03 — exported diagnostics never contain private plan state.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLifecycleState, validateLifecycleState } from './contract.mjs';
import { startDevelopment } from '../orchestration/outbox.mjs';
import { migrateV1State } from './migration.mjs';
import {
  assertSafeDiagnosticPayload, projectReconcileDiagnostic,
} from './diagnostic.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const BASE = 'a'.repeat(40);
const authority = {
  repository: 'BestNathan/nession', event: 'workflow_dispatch',
  permission: 'write', ref: 'refs/heads/main', run_id: 9001,
};
const state = validateLifecycleState({
  ...createLifecycleState({
    registry, issue: 4525, base_sha: BASE,
    developer: 'dev-cursor-01', reviewer: 'review-cursor-01',
    acceptor: 'accept-cursor-01', developer_sha: BASE,
    authority, now: 1000,
  }),
  thread: {
    base_sha: BASE, attempt: 1, id: 'a'.repeat(64),
    head_sha: null, merged_sha: null, fencing_generation: 1,
    checkpoint: {
      version: 3, commit_sha: '3'.repeat(40),
      ciphertext_sha256: '4'.repeat(64), native_session_id: 'native-secret',
    },
  },
  feedback: {
    bundle_sha256: '5'.repeat(64), head_sha: BASE,
    ci_digest: null, review_digest: null, parent_sha256: null,
    repair_round: 1, finding_ids: ['review:R-1'], sources: ['review'],
  },
});
const summary = {
  schema_version: 1,
  kind: 'agent_workflow_v2_reconcile_result',
  issue: 4525,
  wake: { source: 'schedule', reason: 'scheduled_scan' },
  steps: [
    { decision: 'advance', reason: 'dispatch_developer' },
    { decision: 'stale_observation', reason: 'reload_and_reobserve' },
  ],
  store_version: 1,
  phase: 'authorized',
  decision: 'plan',
  reason: 'dispatch_developer',
  migrated: false,
  exhausted: false,
  pending_intents: ['dispatch'],
  // The private next state contains the committed checkpoint binding.
  plan: state,
};

const diagnostic = projectReconcileDiagnostic({ summary, state });
assert.equal(diagnostic.kind, 'agent_workflow_v2_diagnostic');
assert.equal(diagnostic.phase, 'authorized');
assert.equal(diagnostic.decision, 'plan');
assert.equal(diagnostic.reason, 'dispatch_developer');
assert.equal(diagnostic.pending_intents[0], 'dispatch');
assert.equal(diagnostic.counts.pending_actions, 1);
assert.equal(diagnostic.counts.feedback_findings, 1);
assert.equal(diagnostic.plan.next_phase, 'authorized');
assert.deepEqual(diagnostic.plan.next_actions, [{
  role: 'developer', action: 'implement', status: 'pending',
}]);
const serialized = JSON.stringify(diagnostic);
assert.ok(!serialized.includes('native-secret'), 'native session identity is not exported');
assert.ok(!serialized.includes('native_session_id'));
assert.ok(!serialized.includes('checkpoint_path'));
assert.ok(!serialized.includes('"outbox"'));
assert.ok(!serialized.includes('"transitions"'));
assert.ok(!serialized.includes('"thread"'));
assert.ok(Buffer.byteLength(serialized) < 16 * 1024);

// v1 migration plans expose the migration lineage, not the raw v1 state.
const v1 = startDevelopment(registry, {
  issue: 4526, sha: BASE, developer: 'dev-cursor-01',
  reviewer: 'review-cursor-01', acceptor: 'accept-cursor-01',
}, authority);
const migrated = migrateV1State({ state: v1, now: 2000 });
const legacyDiagnostic = projectReconcileDiagnostic({
  summary: {
    ...summary,
    issue: 4526,
    phase: v1.phase,
    reason: 'legacy_migration_required',
    migrated: true,
    plan: migrated,
  },
  state: v1,
});
assert.equal(legacyDiagnostic.legacy.phase, 'ready');
assert.equal(legacyDiagnostic.migration.from_phase, 'ready');
assert.equal(legacyDiagnostic.migration.mapped_phase, 'authorized');
assert.equal(legacyDiagnostic.plan.next_phase, 'authorized');
const legacySerialized = JSON.stringify(legacyDiagnostic);
assert.ok(!legacySerialized.includes('"outbox"'));
assert.ok(!legacySerialized.includes('"transitions"'));

// The whole-payload assertion rejects raw or private keys anywhere.
assert.throws(() => assertSafeDiagnosticPayload({ native_bytes: 'x' }),
  /private|raw/);
assert.throws(() => assertSafeDiagnosticPayload({ outbox: [] }), /private|raw/);
assert.throws(() => assertSafeDiagnosticPayload({ reason: 'line1\nline2' }),
  /control characters/);
assert.throws(() => assertSafeDiagnosticPayload({ reason: 'x'.repeat(401) }),
  /exceeds bound/);
assert.throws(() => assertSafeDiagnosticPayload({ nested: { checkpoint_path: 'x' } }),
  /private|raw/);
assertSafeDiagnosticPayload(diagnostic);

// More than the bounded step count fails closed.
assert.throws(() => projectReconcileDiagnostic({
  summary: { ...summary, steps: new Array(33).fill({ decision: 'wait' }) },
  state,
}), /invalid steps/);

console.log('agent workflow diagnostic selftest: OK');
