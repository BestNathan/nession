// Issue #4482 SC-01/SC-02 executable fixtures:
// one authorized lifecycle, explicit business/execution states, replay/stale
// rejection, the four CI/Review aggregate combinations, exactly one repair,
// Reviewer runtime recovery and the no-Reviewer-Check invariant.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLifecycleState, validateLifecycleState } from './contract.mjs';
import { decideLifecycle, updateExecutionState } from './lifecycle.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const BASE = 'a'.repeat(40);
const PR_BASE = 'b'.repeat(40);
const CANDIDATE = 'c'.repeat(40);
const CANDIDATE2 = 'd'.repeat(40);
const OBLIGATION = 'e'.repeat(64);
const CI_DIGEST = 'f'.repeat(64);
const REVIEW_DIGEST = '1'.repeat(64);
const ACCEPT_DIGEST = '2'.repeat(64);
const now = 1000;

function freshState(overrides = {}) {
  return createLifecycleState({
    registry, issue: 4482, base_sha: BASE,
    developer: 'dev-cursor-01', reviewer: 'review-cursor-01',
    acceptor: 'accept-cursor-01', developer_sha: BASE,
    authority: {
      repository: 'BestNathan/nession', event: 'workflow_dispatch',
      permission: 'write', ref: 'refs/heads/main', run_id: 9001,
    },
    now,
    ...overrides,
  });
}

let clock = 2000;
function observation(state, patch = {}) {
  return {
    issue: state.issue,
    state_version: state.version,
    observed_at: clock++,
    wake: { source: 'github_event', reason: 'fixture', correlation_id: 'c1' },
    pr: null,
    developer: null,
    publisher: null,
    ci: null,
    reviewer: null,
    acceptance: null,
    merge: null,
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

function active(state) {
  return state.outbox.find((entry) =>
    !['retired', 'failed', 'cancelled', 'yielded', 'committed'].includes(entry.status));
}

function dispatch(state, action, runId) {
  const prepared = {
    status: 'prepared', dispatch_id: action.id,
    issuer_run_id: runId, ticket_sha256: 'a'.repeat(64),
  };
  const dispatching = updateExecutionState(state, action.id, {
    status: 'dispatching', receipt: prepared, attempts: action.attempts + 1,
  }, clock++);
  return updateExecutionState(dispatching, action.id, {
    status: 'dispatched',
    run: { id: runId, attempt: 1, verified: true },
  }, clock++);
}

function developerEvent(action, runId, patch = {}) {
  return {
    action_id: action.id, run_id: runId, attempt: 1,
    status: 'completed', outcome: null, target_sha: null,
    failure: null, checkpoint: null, verified: true,
    ...patch,
  };
}

function checkpoint(version) {
  return {
    version,
    commit_sha: '3'.repeat(40),
    ciphertext_sha256: '4'.repeat(64),
    native_session_id: 'native-session-' + version,
  };
}

// Drive a lifecycle from authorized to the requested evaluation inputs.
function runToEvaluation({ ciStatus, reviewOutcome }) {
  let state = freshState();
  let decision = step(state);
  assert.equal(decision.decision, 'advance');
  assert.equal(decision.intents[0].type, 'dispatch');
  assert.equal(decision.intents[0].role, 'developer');

  const developerAction = active(state);
  state = dispatch(state, developerAction, 101);
  decision = step(state, {
    developer: developerEvent(developerAction, 101, {
      status: 'in_progress',
    }),
  });
  assert.equal(decision.decision, 'wait');
  decision = step(state, {
    developer: developerEvent(developerAction, 101, {
      outcome: 'implementation_ready', target_sha: CANDIDATE,
      checkpoint: checkpoint(1),
    }),
  });
  state = apply(decision);
  assert.equal(state.phase, 'publishing');

  const publishAction = active(state);
  assert.equal(publishAction.role, 'publisher');
  state = dispatch(state, publishAction, 102);
  decision = step(state, {
    publisher: {
      action_id: publishAction.id, run_id: 102, attempt: 1,
      status: 'completed', outcome: 'published',
      pr: {
        number: 4482, head_sha: CANDIDATE, base_sha: PR_BASE,
        state: 'open', merged_sha: null,
      },
      failure: null, readback: null, verified: true,
    },
  });
  state = apply(decision);
  assert.equal(state.phase, 'ci_checking');
  assert.equal(state.pr.head_sha, CANDIDATE);

  const check = {
    name: 'quality', workflow: 'ci-quality', conclusion: 'success',
    applicability: 'applicable', evidence_ref: 'run/1',
  };
  decision = step(state, {
    ci: {
      head_sha: CANDIDATE, obligation_sha256: OBLIGATION, status: 'pending',
      digest: CI_DIGEST, checks: [check], observed_at: clock++, verified: true,
    },
  });
  state = apply(decision);
  assert.equal(state.phase, 'ci_checking');

  decision = step(state, {
    ci: {
      head_sha: CANDIDATE, obligation_sha256: OBLIGATION, status: ciStatus,
      digest: CI_DIGEST,
      checks: [{
        ...check, conclusion: ciStatus === 'pass' ? 'success' : 'failure',
      }],
      observed_at: clock++, verified: true,
    },
  });
  state = apply(decision);
  assert.equal(state.phase, 'reviewing');
  const reviewAction = active(state);
  assert.equal(reviewAction.role, 'reviewer');
  state = dispatch(state, reviewAction, 103);

  const findings = reviewOutcome === 'changes_requested' ? [{
    id: 'R-1', severity: 'blocking', category: 'correctness',
    message: 'the aggregate can issue two repairs', file: 'x.mjs', sc: 'SC-02',
  }, {
    id: 'N-1', severity: 'nonblocking', category: 'style',
    message: 'naming', file: null, sc: null,
  }] : [];
  decision = step(state, {
    reviewer: {
      action_id: reviewAction.id, run_id: 103, attempt: 1,
      status: 'completed', outcome: reviewOutcome,
      head_sha: CANDIDATE,
      evidence_generation: reviewAction.evidence_generation,
      digest: REVIEW_DIGEST, findings, verified: true,
    },
  });
  state = apply(decision);
  assert.equal(state.phase, 'evaluating');
  return { state, reviewAction };
}

// ── authorized start and pending dispatch ─────────────────────────────────
let state = freshState();
assert.equal(state.phase, 'authorized');
assert.equal(state.outbox.length, 1);
assert.equal(active(state).status, 'pending');
let decision = step(state);
assert.equal(decision.decision, 'advance');
assert.equal(decision.intents.length, 1);
assert.equal(decision.nextState, null);

// Unauthorized starts and non-owner wake/selection fail closed.
assert.throws(() => freshState({
  authority: {
    repository: 'BestNathan/nession', event: 'issue_comment',
    permission: 'write', ref: 'refs/heads/main', run_id: 1,
  },
}), /unauthorized/);
assert.throws(() => freshState({ developer: 'review-cursor-01' }), /role or ID/);
assert.throws(() => decideLifecycle(state, observation(state, { state_version: state.version + 1 })),
  /not bound/);
assert.throws(() => decideLifecycle(state, observation(state, {
  wake: { source: 'model', reason: 'choose-reviewer' },
})), /invalid wake/);

// ── a completed-but-un-ingested result requests idempotent ingestion ──
{
  let uningested = freshState();
  const action = active(uningested);
  uningested = dispatch(uningested, action, 121);
  const decision = step(uningested, {
    developer: developerEvent(action, 121, {
      outcome: 'uningested', target_sha: null, checkpoint: null,
    }),
  });
  assert.equal(decision.decision, 'recover');
  assert.equal(decision.reason, 'result_not_ingested');
  assert.equal(decision.nextState, null);
  assert.equal(decision.intents.length, 1);
  assert.equal(decision.intents[0].type, 'reingest');
  assert.equal(decision.intents[0].run_id, 121);
}

// ── cancelled/timeout are retried as infrastructure, not model verdicts ─
for (const outcome of ['cancelled', 'timeout']) {
  let cancelled = freshState();
  const action = active(cancelled);
  cancelled = dispatch(cancelled, action, outcome === 'cancelled' ? 111 : 112);
  const decision = step(cancelled, {
    developer: developerEvent(action,
      outcome === 'cancelled' ? 111 : 112, {
        outcome,
        failure: { category: 'infrastructure', code: outcome },
      }),
  });
  assert.equal(decision.decision, 'advance');
  assert.equal(decision.nextState.phase, 'developing');
  assert.equal(decision.nextState.budgets.infrastructure_retries, 1);
  assert.equal(decision.intents.length, 1);
  assert.equal(decision.intents[0].role, 'developer');
  assert.equal(decision.nextState.outbox.find((entry) =>
    entry.id === action.id).receipt.category, 'infrastructure');
}

// ── all four CI × Review combinations produce exactly one repair action ──
for (const [ciStatus, reviewOutcome, expected] of [
  ['pass', 'approved', 'accepting'],
  ['actionable_fail', 'approved', 'developing'],
  ['pass', 'changes_requested', 'developing'],
  ['actionable_fail', 'changes_requested', 'developing'],
]) {
  const { state: evaluated } = runToEvaluation({ ciStatus, reviewOutcome });
  const outcome = step(evaluated);
  const next = apply(outcome);
  assert.equal(next.phase, expected,
    ciStatus + '/' + reviewOutcome + ' must aggregate to ' + expected);
  if (expected === 'developing') {
    const repairs = next.outbox.filter((entry) =>
      entry.role === 'developer' && entry.action === 'repair' &&
      !['retired', 'failed', 'cancelled'].includes(entry.status));
    assert.equal(repairs.length, 1, 'exactly one repair action');
    assert.equal(next.budgets.repair_rounds, 1);
    assert.ok(next.feedback);
    assert.equal(next.feedback.bundle_sha256, repairs[0].feedback_sha256);
    if (ciStatus === 'actionable_fail' && reviewOutcome === 'changes_requested') {
      assert.deepEqual(next.feedback.sources, ['ci', 'review']);
      assert.ok(next.feedback.finding_ids.includes('review:R-1'));
      assert.ok(next.feedback.finding_ids.includes('ci:ci-quality:quality'));
      assert.ok(!next.feedback.finding_ids.some((id) => id.includes('N-1')),
        'nonblocking suggestions never gate repair');
    }
    if (ciStatus === 'actionable_fail' && reviewOutcome === 'approved') {
      // The passed Review is part of the immutable evidence generation.
      assert.deepEqual(next.feedback.sources, ['ci', 'review']);
      assert.ok(next.feedback.review_digest);
      assert.ok(next.feedback.ci_digest);
    }
    if (ciStatus === 'pass' && reviewOutcome === 'changes_requested') {
      // The passed CI receipt is part of the immutable evidence generation.
      assert.deepEqual(next.feedback.sources, ['ci', 'review']);
      assert.ok(next.feedback.ci_digest);
      assert.ok(next.feedback.review_digest);
    }
  } else {
    const accepts = next.outbox.filter((entry) =>
      entry.role === 'acceptor' && entry.status === 'pending');
    assert.equal(accepts.length, 1);
    assert.equal(accepts[0].gate, 'pr');
  }
}

// Repair budget exhaustion blocks explicitly; no second repair is created.
{
  const { state: evaluated } = runToEvaluation({
    ciStatus: 'actionable_fail', reviewOutcome: 'approved',
  });
  const blocked = step(evaluated, {}, { max_repair_rounds: 0 });
  assert.equal(blocked.decision, 'block');
  assert.equal(blocked.reason, 'repair_budget_exhausted');
  assert.equal(blocked.nextState.phase, 'blocked');
  assert.equal(blocked.nextState.blocker.owner_action_required, true);
}

// ── Reviewer runtime failure retries Reviewer, never Developer ───────────
{
  let reviewing = freshState();
  const dev = active(reviewing);
  reviewing = dispatch(reviewing, dev, 201);
  reviewing = apply(step(reviewing, {
    developer: developerEvent(dev, 201, {
      outcome: 'implementation_ready', target_sha: CANDIDATE, checkpoint: checkpoint(1),
    }),
  }));
  const pub = active(reviewing);
  reviewing = dispatch(reviewing, pub, 202);
  reviewing = apply(step(reviewing, {
    publisher: {
      action_id: pub.id, run_id: 202, attempt: 1, status: 'completed',
      outcome: 'published',
      pr: {
        number: 4482, head_sha: CANDIDATE, base_sha: PR_BASE,
        state: 'open', merged_sha: null,
      },
      failure: null, readback: null, verified: true,
    },
  }));
  reviewing = apply(step(reviewing, {
    ci: {
      head_sha: CANDIDATE, obligation_sha256: OBLIGATION, status: 'pass',
      digest: CI_DIGEST,
      checks: [{
        name: 'quality', workflow: 'ci-quality', conclusion: 'success',
        applicability: 'applicable', evidence_ref: null,
      }],
      observed_at: clock++, verified: true,
    },
  }));
  const reviewer = active(reviewing);
  reviewing = dispatch(reviewing, reviewer, 203);
  const retry = step(reviewing, {
    reviewer: {
      action_id: reviewer.id, run_id: 203, attempt: 1, status: 'completed',
      outcome: 'runtime_failure', head_sha: CANDIDATE,
      evidence_generation: reviewer.evidence_generation,
      digest: REVIEW_DIGEST, findings: [], verified: true,
    },
  });
  assert.equal(retry.decision, 'advance');
  assert.equal(retry.nextState.phase, 'reviewing');
  assert.equal(retry.intents.length, 1);
  assert.equal(retry.intents[0].role, 'reviewer');
  assert.equal(retry.nextState.outbox.some((entry) =>
    entry.role === 'developer' && entry.action === 'repair' &&
    !['failed', 'cancelled', 'retired'].includes(entry.status)), false);
}

// ── stale Reviewer evidence and replay are rejected without a write ──────
{
  const { state: evaluating } = runToEvaluation({
    ciStatus: 'pass', reviewOutcome: 'approved',
  });
  const lastReview = [...evaluating.transitions].reverse()
    .find((transition) => transition.kind === 'reviewer');
  assert.ok(lastReview);
  const replayDecision = step(evaluating, {
    reviewer: {
      action_id: lastReview.action_id, run_id: lastReview.run_id,
      attempt: lastReview.attempt, status: 'completed', outcome: 'approved',
      head_sha: CANDIDATE,
      evidence_generation: lastReview.evidence_generation,
      digest: REVIEW_DIGEST, findings: [], verified: true,
    },
  });
  assert.equal(replayDecision.decision, 'replay');
  assert.equal(replayDecision.nextState, null);
}

// ── stale HEAD / out-of-band merge fail closed ───────────────────────────
{
  const { state: evaluating } = runToEvaluation({
    ciStatus: 'pass', reviewOutcome: 'approved',
  });
  const changed = step(evaluating, {
    pr: {
      number: 4482, head_sha: CANDIDATE2, base_sha: PR_BASE,
      state: 'open', merged_sha: null,
    },
  });
  assert.equal(changed.decision, 'block');
  assert.equal(changed.reason, 'unauthorized_head_change');
  assert.equal(changed.nextState.phase, 'blocked');

  const merged = step(evaluating, {
    pr: {
      number: 4482, head_sha: CANDIDATE, base_sha: PR_BASE,
      state: 'merged', merged_sha: CANDIDATE2,
    },
  });
  assert.equal(merged.decision, 'block');
  assert.equal(merged.reason, 'out_of_band_merge');
}

// ── executing-state edges are strict ────────────────────────────────────
{
  const s = freshState();
  const action = active(s);
  assert.throws(() => updateExecutionState(s, action.id, { status: 'committed' }, 1),
    /illegal execution/);
  const dispatching = updateExecutionState(s, action.id, {
    status: 'dispatching',
    receipt: {
      status: 'prepared', dispatch_id: action.id, issuer_run_id: 1,
      ticket_sha256: 'a'.repeat(64),
    },
    attempts: 1,
  }, 1);
  assert.throws(() => updateExecutionState(dispatching, action.id, { status: 'executing' }, 2),
    /illegal execution/);
}

// ── no Reviewer GitHub Check/status is introduced ───────────────────────
{
  const workflow = readFileSync('.github/workflows/agent-review.yml', 'utf8');
  assert.ok(!/statuses:\s*write|checks:\s*write/.test(workflow),
    'Agent / Review must not mint a GitHub check/status');
  const contracts = [
    'scripts/lib/agent/workflow/lifecycle.mjs',
    'scripts/lib/agent/workflow/reconcile.mjs',
    'scripts/lib/agent/workflow/contract.mjs',
  ].map((path) => readFileSync(path, 'utf8')).join('\n');
  assert.ok(!/check-runs|check_runs|statuses\/[a-z]/i.test(contracts),
    'V2 lifecycle code must not create Reviewer check/status contexts');
}

// ── the legacy engine never accepts a v2 state ──────────────────────────
{
  const { advanceWorkflow } = await import('../orchestration/transition.mjs');
  assert.throws(() => advanceWorkflow(freshState(), {}, {}), /schema v2 states are owned/);
}

console.log('agent workflow lifecycle selftest: OK');
