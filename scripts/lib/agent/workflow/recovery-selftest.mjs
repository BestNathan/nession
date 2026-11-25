// Issue #4527 SC-01/SC-02 — generic terminal recovery, checkpoint retention
// and no unsafe rerun on unhealthy evidence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeAction, createLifecycleState } from './contract.mjs';
import { decideLifecycle, updateExecutionState } from './lifecycle.mjs';
import {
  applyTerminalRecovery, classifyRecovery, planTerminalRecovery,
} from './recovery.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const BASE = 'a'.repeat(40);
const CANDIDATE = 'c'.repeat(40);
const PR_BASE = 'b'.repeat(40);
const OBLIGATION = 'e'.repeat(64);
const CI_DIGEST = 'f'.repeat(64);
const REVIEW_DIGEST = '1'.repeat(64);
let clock = 1000;
const authority = {
  repository: 'BestNathan/nession', event: 'workflow_dispatch',
  permission: 'write', ref: 'refs/heads/main', run_id: 9001,
};
function fresh() {
  return createLifecycleState({
    registry, issue: 4527, base_sha: BASE, developer: 'dev-cursor-01',
    reviewer: 'review-cursor-01', acceptor: 'accept-cursor-01',
    developer_sha: BASE, authority, now: 1000,
  });
}
function observation(state, patch = {}) {
  return {
    issue: state.issue, state_version: state.version, observed_at: clock++,
    wake: { source: 'github_event', reason: 'fixture', correlation_id: 'c1' },
    pr: null, developer: null, publisher: null, ci: null,
    reviewer: null, acceptance: null, merge: null, ...patch,
  };
}
function step(state, patch = {}) {
  return decideLifecycle(state, observation(state, patch));
}
function apply(decision) {
  assert.ok(decision.nextState, decision.reason);
  return decision.nextState;
}
function dispatch(state, action, runId) {
  const dispatching = updateExecutionState(state, action.id, {
    status: 'dispatching',
    receipt: {
      status: 'prepared', dispatch_id: action.id, issuer_run_id: runId,
      ticket_sha256: 'a'.repeat(64),
    },
    attempts: action.attempts + 1,
  }, clock++);
  return updateExecutionState(dispatching, action.id, {
    status: 'dispatched', run: { id: runId, attempt: 1, verified: true },
  }, clock++);
}
function checkpoint(version) {
  return {
    version, commit_sha: '3'.repeat(40),
    ciphertext_sha256: '4'.repeat(64), native_session_id: 'native-' + version,
  };
}
function toDeveloper(runId = 101) {
  let state = fresh();
  const action = activeAction(state);
  return { state: dispatch(state, action, runId), action };
}
function toReviewer() {
  let state = fresh();
  let action = activeAction(state);
  state = dispatch(state, action, 101);
  state = apply(step(state, {
    developer: {
      action_id: action.id, run_id: 101, attempt: 1, status: 'completed',
      outcome: 'implementation_ready', target_sha: CANDIDATE, failure: null,
      checkpoint: checkpoint(1), verified: true,
    },
  }));
  action = activeAction(state);
  state = dispatch(state, action, 102);
  state = apply(step(state, {
    publisher: {
      action_id: action.id, run_id: 102, attempt: 1, status: 'completed',
      outcome: 'published',
      pr: {
        number: 4527, head_sha: CANDIDATE, base_sha: PR_BASE,
        state: 'open', merged_sha: null,
      },
      failure: null, readback: null, verified: true,
    },
  }));
  state = apply(step(state, {
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
  action = activeAction(state);
  return { state: dispatch(state, action, 103), action };
}
function terminalFailure(runId, patch = {}) {
  return {
    kind: 'terminal_failure', run: { id: runId, attempt: 1 },
    category: 'model', code: 'spawn_etimedout', outcome: 'failed', ...patch,
  };
}

// ── #3981 terminal post-model failure and missed wake ─────────────────
{
  const { state, action } = toDeveloper(45560094514);
  const plan = planTerminalRecovery({
    state, action, fact: terminalFailure(45560094514),
  });
  assert.equal(plan.action, 'retire_successor');
  assert.equal(plan.class, 'terminal_failure');
  assert.equal(plan.category, 'model');
  assert.equal(plan.retirement.source_run_id, 45560094514);
  assert.equal(plan.successor.role, 'developer');
  assert.equal(plan.successor.predecessor, action.id);
  assert.equal(plan.budget.model_retries, 1);
  const next = applyTerminalRecovery(state, plan, clock++);
  assert.equal(next.phase, 'developing');
  assert.equal(next.thread.id, state.thread.id, 'same logical Thread');
  assert.equal(next.thread.attempt, state.thread.attempt + 1);
  const failed = next.outbox.find((entry) => entry.id === action.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.receipt.category, 'model');
  const successors = next.outbox.filter((entry) =>
    entry.role === 'developer' && entry.status === 'pending');
  assert.equal(successors.length, 1);
  assert.equal(successors[0].predecessor, action.id);

  // A duplicate fact on the already-retired action cannot create a second
  // successor.
  const duplicate = planTerminalRecovery({
    state: next, action: failed, fact: terminalFailure(45560094514),
  });
  assert.equal(duplicate.action, 'none');
  assert.equal(applyTerminalRecovery(next, duplicate, clock++), null);
}

// ── unhealthy/unknown evidence never reruns the model ────────────────
{
  const { state, action } = toDeveloper();
  for (const [fact, reason] of [
    [{ kind: 'terminal_failure', category: 'model', code: 'failed' }, 'ambiguous_effect'],
    [{ kind: 'denied', reason: 'policy_denied' }, 'policy_denied'],
    [{ kind: 'ambiguous' }, 'unknown_evidence'],
    [{ kind: 'unavailable', reason: 'api_unavailable' }, 'unknown_evidence'],
  ]) {
    const plan = planTerminalRecovery({ state, action, fact });
    assert.equal(plan.action, 'block');
    assert.equal(plan.reason, reason);
    const next = applyTerminalRecovery(state, plan, clock++);
    assert.equal(next.phase, 'blocked');
    assert.equal(next.outbox.filter((entry) => entry.status === 'pending').length, 0);
  }
  const waiting = planTerminalRecovery({
    state, action,
    fact: { kind: 'running', run: { id: 101, attempt: 1 }, status: 'in_progress' },
  });
  assert.equal(waiting.action, 'wait');
}

// ── completed-but-uningested is ingested, never rerun ────────────────
{
  const { state, action } = toDeveloper();
  const plan = planTerminalRecovery({
    state, action,
    fact: { kind: 'completed_uningested', run: { id: 101, attempt: 1 } },
  });
  assert.equal(plan.action, 'reingest');
  assert.equal(plan.run_id, 101);
  assert.equal(applyTerminalRecovery(state, plan, clock++), null);
  const healthy = planTerminalRecovery({
    state, action, fact: { kind: 'terminal_result' },
  });
  assert.equal(healthy.action, 'wait');
}

// ── exhausted budgets block without a successor ──────────────────────
{
  const { state, action } = toDeveloper();
  const plan = planTerminalRecovery({
    state, action, fact: terminalFailure(101),
    config: { max_model_retries: 0 },
  });
  assert.equal(plan.action, 'block');
  assert.equal(plan.reason, 'model_budget_exhausted');
  const next = applyTerminalRecovery(state, plan, clock++);
  assert.equal(next.phase, 'blocked');
}

// ── a committed checkpoint survives retirement and resume ────────────
{
  const { state: raw, action } = toDeveloper();
  const state = {
    ...raw,
    thread: { ...raw.thread, checkpoint: checkpoint(2) },
  };
  const plan = planTerminalRecovery({
    state, action, fact: terminalFailure(101),
  });
  assert.equal(plan.action, 'retire_successor');
  assert.deepEqual(plan.checkpoint, checkpoint(2));
  assert.equal(plan.successor.resume, true);
  const next = applyTerminalRecovery(state, plan, clock++);
  assert.deepEqual(next.thread.checkpoint, checkpoint(2));
  assert.equal(next.thread.checkpoint.native_session_id, 'native-2');
  assert.equal(next.thread.id, state.thread.id);

  const corrupt = planTerminalRecovery({
    state, action,
    fact: terminalFailure(101, { checkpoint_corrupt: true }),
  });
  assert.equal(corrupt.action, 'block');
  assert.equal(corrupt.reason, 'checkpoint_corrupt');
}

// ── Reviewer failure recovers Reviewer, not Developer ────────────────
{
  const { state, action } = toReviewer();
  const plan = planTerminalRecovery({
    state, action,
    fact: {
      kind: 'terminal_failure', run: { id: 103, attempt: 1 },
      category: 'model', code: 'reviewer_runtime_failure', outcome: 'failed',
    },
  });
  assert.equal(plan.action, 'retire_successor');
  assert.equal(plan.successor.role, 'reviewer');
  assert.equal(plan.next_phase, 'reviewing');
  const next = applyTerminalRecovery(state, plan, clock++);
  assert.equal(next.phase, 'reviewing');
  assert.equal(next.outbox.some((entry) =>
    entry.role === 'developer' && entry.status === 'pending'), false);
}

// ── classification is explicit and total ─────────────────────────────
{
  const { state, action } = toDeveloper();
  assert.equal(classifyRecovery({ state, action, fact: null }).class, 'unknown');
  assert.equal(classifyRecovery({
    state, action, fact: { kind: 'running', claimed: true },
  }).class, 'claimed');
  assert.equal(classifyRecovery({
    state, action, fact: { kind: 'running', executing: true },
  }).class, 'executing');
  assert.equal(classifyRecovery({
    state, action,
    fact: { kind: 'terminal_failure', run: { id: 1, attempt: 1 },
      code: 'artifact_expired', category: 'infrastructure' },
  }).class, 'expired_artifact');
  assert.equal(classifyRecovery({
    state, action,
    fact: { kind: 'terminal_failure', run: { id: 1, attempt: 1 },
      code: 'result_missing', category: 'model' },
  }).class, 'missing_result');
}

console.log('agent workflow recovery selftest: OK');
