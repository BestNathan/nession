// Issue #4482 SC-05 compatibility fixtures: immutable v1 history maps to an
// explicit v2 projection, unknown/ambiguous legacy state blocks with a
// diagnostic, and no V2 decision owner accepts a v1 state.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startDevelopment, acceptTaskResult, recordDispatch } from '../orchestration/outbox.mjs';
import { decideLifecycle } from './lifecycle.mjs';
import { legacyLifecycleDigest, migrateV1State } from './migration.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const issue = 4482;
const BASE = 'a'.repeat(40);
const CANDIDATE = 'b'.repeat(40);
const PR_HEAD = CANDIDATE;
const PR_BASE = 'c'.repeat(40);
const request = {
  issue, sha: BASE, developer: 'dev-cursor-01',
  reviewer: 'review-cursor-01', acceptor: 'accept-cursor-01',
};
const authority = {
  repository: 'BestNathan/nession', event: 'workflow_dispatch',
  permission: 'write', ref: 'refs/heads/main', run_id: 1001,
};
const pr = {
  number: 4500, head_sha: PR_HEAD, base_sha: PR_BASE,
  state: 'open', merged_sha: null,
};

let v1 = startDevelopment(registry, request, authority);
assert.equal(v1.schema_version, 1);
assert.equal(v1.phase, 'ready');
const readyDigest = legacyLifecycleDigest(v1);
assert.match(readyDigest, /^[a-f0-9]{64}$/);

const ready = migrateV1State({ state: v1, now: 2000 });
assert.equal(ready.schema_version, 2);
assert.equal(ready.version, 1);
assert.equal(ready.phase, 'authorized');
assert.equal(ready.migration.from_phase, 'ready');
assert.equal(ready.migration.mapped_phase, 'authorized');
assert.equal(ready.migration.from_version, v1.version);
assert.match(ready.migration.from_digest, /^[a-f0-9]{64}$/);
assert.equal(ready.outbox.length, 1);
assert.equal(ready.outbox[0].id, v1.outbox[0].id, 'action identity is preserved');
assert.equal(ready.outbox[0].status, 'pending');
assert.equal(ready.start.authority_run_id, 0, 'legacy start Run is explicitly unknown');
assert.equal(legacyLifecycleDigest(v1), readyDigest, 'legacy identity is deterministic');

// A V2 decision owner must reject a raw v1 state.
assert.throws(() => decideLifecycle(v1, {
  issue, state_version: v1.version, observed_at: 1,
  wake: { source: 'manual', reason: 'x' },
}), /invalid v2 state/);

// Advance the legacy lifecycle to a Reviewer-first state.
let item = v1.outbox[0];
v1 = recordDispatch(v1, v1.version, item.id, {
  status: 'accepted', dispatch_id: item.id,
});
const result = {
  kind: 'developer', issue, run_id: 5001, run_attempt: 1,
  target_sha: CANDIDATE, outcome: 'implementation_ready', task_id: item.id,
};
const source = {
  repository: 'BestNathan/nession',
  path: '.github/workflows/agent-develop.yml', name: 'Agent / Development',
  run_id: 5001, attempt: 1, event: 'workflow_dispatch', ref: 'refs/heads/main',
  issue, task_id: item.id, agent_id: 'dev-cursor-01',
  input_sha: BASE, output_sha: CANDIDATE, verified: true,
};
v1 = acceptTaskResult(v1, v1.version, result, source, registry);
assert.equal(v1.phase, 'review');
assert.equal(v1.outbox.filter((entry) => entry.status === 'pending').length, 1);

const review = migrateV1State({ state: v1, pr, now: 3000 });
assert.equal(review.phase, 'reviewing');
assert.equal(review.migration.from_phase, 'review');
assert.equal(review.migration.mapped_phase, 'reviewing');
assert.equal(review.migration.legacy_order, 'reviewer_first');
assert.equal(review.thread.head_sha, PR_HEAD);
assert.equal(review.pr.number, pr.number);
assert.equal(review.outbox.length, 1);
assert.equal(review.outbox[0].role, 'reviewer');
assert.match(review.outbox[0].evidence_generation, /^[a-f0-9]{64}$/);
assert.equal(review.transitions.length, v1.transitions.length);
assert.equal(review.transitions[0].kind, 'developer');

// Legacy state without a trusted PR readback never guesses a PR.
const blocked = migrateV1State({ state: v1, now: 3000 });
assert.equal(blocked.phase, 'blocked');
assert.equal(blocked.substate, 'legacy_migration_blocked');
assert.match(blocked.blocker.reason, /requires_pr_readback/);
assert.equal(blocked.blocker.owner_action_required, true);
assert.equal(blocked.outbox.length, 0);

// A mismatched readback blocks rather than rebinding another PR/HEAD.
const mismatch = migrateV1State({
  state: v1,
  pr: { ...pr, head_sha: 'd'.repeat(40) },
  now: 3000,
});
assert.equal(mismatch.phase, 'blocked');
assert.match(mismatch.blocker.reason, /head_differs_from_pr/);

// Legacy completion history remains readable without rewriting the source.
const doneV1 = { ...v1, phase: 'done', merged_sha: CANDIDATE, target_sha: CANDIDATE };
const done = migrateV1State({ state: doneV1, now: 4000 });
assert.equal(done.phase, 'done');
assert.equal(done.thread.merged_sha, CANDIDATE);
assert.equal(done.migration.from_phase, 'done');
assert.equal(done.migration.from_version, v1.version);

// A blocked v1 lifecycle projects to an explicit owner-recovery blocker.
const blockedV1 = { ...v1, phase: 'blocked' };
const blockedLegacy = migrateV1State({ state: blockedV1, now: 4000 });
assert.equal(blockedLegacy.phase, 'blocked');
assert.equal(blockedLegacy.blocker.owner_action_required, true);

// An unsupported schema is rejected outright.
assert.throws(() => migrateV1State({
  state: { ...v1, schema_version: 3 }, now: 1,
}), /invalid state shape/);

console.log('agent workflow migration selftest: OK');
