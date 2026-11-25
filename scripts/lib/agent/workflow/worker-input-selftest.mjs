// Issue #4528 SC-03 executable orchestration→worker-input fixtures.
//
// Proves: for all four CI × Review combinations the aggregate produces exactly
// one feedback bundle carrying BOTH receipts (including the passed side),
// exactly one signed Developer repair input to the same Thread/checkpoint, and
// only CI-pass + approved proceeds toward acceptance. A Reviewer runtime
// failure recovers the Reviewer and never becomes a Developer repair.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createLifecycleState, stableDigest, validateLifecycleState,
} from './contract.mjs';
import { decideLifecycle, updateExecutionState } from './lifecycle.mjs';
import { buildFeedbackBundle, verifyFeedbackBundle } from './feedback.mjs';
import { renderRepairWorkerInput } from './worker-input.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const BASE = 'a'.repeat(40);
const PR_BASE = 'b'.repeat(40);
const CANDIDATE = 'c'.repeat(40);
const OBLIGATION = 'e'.repeat(64);
const CI_DIGEST = 'f'.repeat(64);
const REVIEW_DIGEST = '1'.repeat(64);
let clock = 1000;

function freshState() {
  return createLifecycleState({
    registry, issue: 4528, base_sha: BASE,
    developer: 'dev-cursor-01', reviewer: 'review-cursor-01',
    acceptor: 'accept-cursor-01', developer_sha: BASE,
    authority: {
      repository: 'BestNathan/nession', event: 'workflow_dispatch',
      permission: 'write', ref: 'refs/heads/main', run_id: 9001,
    },
    now: 1000,
  });
}
function active(state) {
  return state.outbox.find((entry) =>
    !['retired', 'failed', 'cancelled', 'yielded', 'committed'].includes(entry.status));
}
function observation(state, patch = {}) {
  return {
    issue: state.issue,
    state_version: state.version,
    observed_at: clock++,
    wake: { source: 'github_event', reason: 'fixture', correlation_id: 'c1' },
    pr: null, developer: null, publisher: null, ci: null,
    reviewer: null, acceptance: null, merge: null,
    ...patch,
  };
}
function step(state, patch = {}, config = {}) {
  const decision = decideLifecycle(state, observation(state, patch), config);
  if (decision.nextState != null) validateLifecycleState(decision.nextState);
  return decision;
}
function apply(decision) {
  assert.ok(decision.nextState, decision.reason);
  return decision.nextState;
}
function dispatch(state, action, runId) {
  const dispatching = updateExecutionState(state, action.id, {
    status: 'dispatching', attempts: action.attempts + 1,
    receipt: {
      status: 'prepared', dispatch_id: action.id,
      issuer_run_id: runId, ticket_sha256: 'a'.repeat(64),
    },
  }, clock++);
  return updateExecutionState(dispatching, action.id, {
    status: 'dispatched', run: { id: runId, attempt: 1, verified: true },
  }, clock++);
}
function checkpoint(version) {
  return {
    version,
    commit_sha: '3'.repeat(40),
    ciphertext_sha256: '4'.repeat(64),
    native_session_id: 'native-session-' + version,
  };
}
// authorized -> developer -> publisher -> CI pending -> CI terminal ->
// Reviewer dispatched. Returns the state just before the Reviewer result.
function runToReviewer({ ciStatus }) {
  let state = freshState();
  const developer = active(state);
  state = dispatch(state, developer, 101);
  state = apply(step(state, {
    developer: {
      action_id: developer.id, run_id: 101, attempt: 1, status: 'completed',
      outcome: 'implementation_ready', target_sha: CANDIDATE,
      checkpoint: checkpoint(1), failure: null, verified: true,
    },
  }));
  const publisher = active(state);
  state = dispatch(state, publisher, 102);
  state = apply(step(state, {
    publisher: {
      action_id: publisher.id, run_id: 102, attempt: 1,
      status: 'completed', outcome: 'published',
      pr: {
        number: 4528, head_sha: CANDIDATE, base_sha: PR_BASE,
        state: 'open', merged_sha: null,
      },
      failure: null, readback: null, verified: true,
    },
  }));
  const check = {
    name: 'web-check', workflow: 'ci-quality.yml', conclusion: 'success',
    applicability: 'applicable', evidence_ref: 'run:1/attempt:1/job:1',
  };
  state = apply(step(state, {
    ci: {
      head_sha: CANDIDATE, obligation_sha256: OBLIGATION, status: 'pending',
      digest: CI_DIGEST, checks: [{ ...check, conclusion: 'pending' }],
      observed_at: clock++, verified: true,
    },
  }));
  state = apply(step(state, {
    ci: {
      head_sha: CANDIDATE, obligation_sha256: OBLIGATION, status: ciStatus,
      digest: CI_DIGEST,
      checks: [{ ...check, conclusion: ciStatus === 'pass' ? 'success' : 'failure' }],
      observed_at: clock++, verified: true,
    },
  }));
  const reviewAction = active(state);
  assert.equal(reviewAction.role, 'reviewer');
  state = dispatch(state, reviewAction, 103);
  return { state, reviewAction, developer };
}
function reviewerResult(reviewAction, outcome) {
  const findings = outcome === 'changes_requested' ? [{
    id: 'R-1', severity: 'blocking', category: 'correctness',
    message: 'the aggregate can issue two repairs', file: 'x.mjs', sc: 'SC-02',
  }, {
    id: 'N-1', severity: 'nonblocking', category: 'style',
    message: 'naming', file: null, sc: null,
  }] : [];
  return {
    action_id: reviewAction.id, run_id: 103, attempt: 1,
    status: 'completed', outcome,
    head_sha: CANDIDATE,
    evidence_generation: reviewAction.evidence_generation,
    digest: REVIEW_DIGEST, findings, verified: true,
  };
}
function signer({ intent_sha256 }) {
  return {
    signature: createHash('sha256').update('fixture-key:' + intent_sha256).digest('hex'),
    signer_id: 'trusted-dispatcher',
  };
}
function reviewToEvaluation({ ciStatus, reviewOutcome }) {
  const { state, reviewAction, developer } = runToReviewer({ ciStatus });
  const evaluated = apply(step(state, {
    reviewer: reviewerResult(reviewAction, reviewOutcome),
  }));
  assert.equal(evaluated.phase, 'evaluating');
  return { evaluated, reviewAction, developer };
}

// ── all four combinations: unique bundle, both receipts, one signed intent ─
const combinations = [
  ['pass', 'approved', 'accepting'],
  ['actionable_fail', 'approved', 'developing'],
  ['pass', 'changes_requested', 'developing'],
  ['actionable_fail', 'changes_requested', 'developing'],
];
for (const [ciStatus, reviewOutcome, phase] of combinations) {
  const { evaluated, developer } = reviewToEvaluation({ ciStatus, reviewOutcome });
  const decision = step(evaluated);
  const next = apply(decision);
  assert.equal(next.phase, phase);
  if (phase !== 'developing') {
    assert.equal(decision.intents.length, 1);
    assert.equal(decision.intents[0].role, 'acceptor');
    assert.equal(next.feedback, null, 'acceptance is not a repair');
    continue;
  }
  assert.equal(decision.reason, 'aggregate_repair');
  assert.equal(decision.intents.length, 1, 'exactly one repair intent');
  assert.equal(decision.intents[0].role, 'developer');
  assert.equal(next.feedback.sources.join(','), 'ci,review',
    'both evidence receipts are included even when one side passed');
  assert.equal(next.feedback.ci_digest, CI_DIGEST);
  assert.equal(next.feedback.review_digest, REVIEW_DIGEST);
  const content = verifyFeedbackBundle({ bundle: next.feedback, issue: 4528, pr: 4528 });
  assert.equal(content.head_sha, CANDIDATE);
  assert.equal(content.findings.length, next.feedback.findings.length);
  const repair = next.outbox.find((entry) =>
    entry.role === 'developer' && entry.action === 'repair');
  assert.equal(repair.status, 'pending');
  assert.equal(repair.feedback_sha256, next.feedback.bundle_sha256);
  assert.equal(repair.predecessor, developer.id, 'same Developer Thread lineage');

  const input = renderRepairWorkerInput({ state: next, signer });
  assert.equal(input.kind, 'agent_workflow_v2_repair_input');
  assert.equal(input.issue, 4528);
  assert.equal(input.pr, 4528);
  assert.equal(input.head_sha, CANDIDATE);
  assert.equal(input.thread_id, next.thread.id);
  assert.equal(input.action_id, repair.id);
  assert.equal(input.repair_round, 1);
  assert.equal(input.resume, true);
  assert.deepEqual(input.checkpoint, {
    version: 1, commit_sha: '3'.repeat(40), ciphertext_sha256: '4'.repeat(64),
    session_bound: true,
  }, 'same checkpoint binding; native session identity stays private');
  assert.equal(input.ci.status, ciStatus);
  assert.equal(input.ci.digest, CI_DIGEST);
  assert.equal(input.review.outcome, reviewOutcome);
  assert.equal(input.review.digest, REVIEW_DIGEST);
  assert.equal(input.feedback.bundle_sha256, next.feedback.bundle_sha256);
  assert.deepEqual(input.feedback.sources, ['ci', 'review']);
  assert.equal(input.signature.length, 64);
  assert.equal(input.signer_id, 'trusted-dispatcher');
  const { signature, signer_id, intent_sha256, ...payload } = input;
  assert.equal(intent_sha256, stableDigest(payload),
    'signature binds the exact intent');
  assert.equal(signature, signer({ intent_sha256 }).signature);

  const findingIds = input.feedback.findings.map((finding) => finding.id);
  if (ciStatus !== 'pass') assert.ok(findingIds.includes('ci:ci-quality.yml:web-check'));
  if (reviewOutcome === 'changes_requested') assert.ok(findingIds.includes('review:R-1'));
  assert.ok(!findingIds.some((id) => id.includes('N-1')),
    'nonblocking findings never enter the repair input');
  assert.ok(!JSON.stringify(input).includes('native-session-1'),
    'the native session identity is not leaked in the worker input');

  // Tampering with the persisted bundle is detected.
  const tampered = {
    ...next,
    feedback: {
      ...next.feedback,
      findings: next.feedback.findings.map((finding, index) => index === 0 ?
        { ...finding, message: 'rewritten' } : finding),
    },
  };
  assert.throws(() => renderRepairWorkerInput({ state: tampered, signer }),
    /feedback bundle digest mismatch/);

  // A bundle that omits the passed side is not accepted as a unified input.
  const reviewOnly = buildFeedbackBundle({
    issue: 4528, pr: 4528, head_sha: CANDIDATE,
    review: next.review, prior: null, repair_round: 1,
  });
  const partial = validateLifecycleState({
    ...next,
    feedback: reviewOnly,
    outbox: next.outbox.map((entry) => entry.action === 'repair' ?
      { ...entry, feedback_sha256: reviewOnly.bundle_sha256 } : entry),
  });
  assert.throws(() => renderRepairWorkerInput({ state: partial, signer }),
    /both CI and Review receipts/);
}

// ── Reviewer runtime failure recovers the Reviewer, never Developer ──────
{
  const { state, reviewAction } = runToReviewer({ ciStatus: 'pass' });
  const decision = step(state, {
    reviewer: {
      action_id: reviewAction.id, run_id: 103, attempt: 1,
      status: 'completed', outcome: 'runtime_failure',
      head_sha: CANDIDATE,
      evidence_generation: reviewAction.evidence_generation,
      digest: REVIEW_DIGEST, findings: [], verified: true,
    },
  });
  assert.equal(decision.decision, 'advance');
  assert.equal(decision.intents.length, 1);
  assert.equal(decision.intents[0].type, 'dispatch');
  assert.equal(decision.intents[0].role, 'reviewer');
  assert.ok(!decision.nextState.outbox.some((entry) =>
    entry.role === 'developer' && entry.action === 'repair' &&
    entry.status === 'pending'), 'a runtime failure is not a code verdict');
  assert.equal(decision.nextState.review, null);
}

// ── Reviewer result ingestion never schedules repair by itself ──────────
{
  const { state, reviewAction } = runToReviewer({ ciStatus: 'pass' });
  const decision = step(state, {
    reviewer: reviewerResult(reviewAction, 'changes_requested'),
  });
  assert.equal(decision.nextState.phase, 'evaluating');
  assert.equal(decision.intents.length, 0, 'ingestion is not a repair trigger');
  const repairs = decision.nextState.outbox.filter((entry) =>
    entry.role === 'developer' && entry.action === 'repair');
  assert.equal(repairs.length, 0, 'only the aggregate decision creates repair');
}

console.log('agent workflow worker-input selftest: OK');
