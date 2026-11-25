// Issue #4528 SC-02 executable retry/fault fixtures.
//
// Proves: a durable system `ci_retry` action is written before the external
// rerun request, its committed receipt binds the exact rerun Run/attempt, a
// lost response is read back instead of re-requested, an unresolved/unknown
// retry never duplicates the external effect, budgets are cumulative and
// persistent, and a stale-head retry is never sent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLifecycleState, validateLifecycleState } from './contract.mjs';
import { decideLifecycle, updateExecutionState } from './lifecycle.mjs';
import { reconcileOnce } from './reconcile.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const BASE = 'a'.repeat(40);
const PR_BASE = 'b'.repeat(40);
const CANDIDATE = 'c'.repeat(40);
const NEW_HEAD = 'd'.repeat(40);
const OBLIGATION = 'e'.repeat(64);
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
function observation(state, wake, patch = {}) {
  return {
    issue: state.issue,
    state_version: state.version,
    observed_at: clock++,
    wake: { source: wake.source, reason: wake.reason, correlation_id: null },
    pr: null, developer: null, publisher: null, ci: null,
    reviewer: null, acceptance: null, merge: null,
    ...patch,
  };
}
function step(state, patch = {}, config = {}) {
  const decision = decideLifecycle(state, observation(state,
    { source: 'schedule', reason: 'fixture' }, patch), config);
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
// Drive an authorized lifecycle to `ci_checking` for the exact candidate HEAD.
function publishedState() {
  let state = freshState();
  const developer = active(state);
  state = dispatch(state, developer, 101);
  state = apply(step(state, {
    developer: {
      action_id: developer.id, run_id: 101, attempt: 1, status: 'completed',
      outcome: 'implementation_ready', target_sha: CANDIDATE,
      checkpoint: {
        version: 1, commit_sha: '1'.repeat(40),
        ciphertext_sha256: '2'.repeat(64), native_session_id: 'n1',
      },
      failure: null, verified: true,
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
  assert.equal(state.phase, 'ci_checking');
  return state;
}
function ciEvidence({ status = 'missing', digest, ref = 'run:1/attempt:1/job:1' }) {
  return {
    head_sha: CANDIDATE, obligation_sha256: OBLIGATION, status, digest,
    checks: [{
      name: 'web-check', workflow: 'ci-quality.yml',
      conclusion: status === 'pass' ? 'success' :
        status === 'pending' ? 'pending' :
        status === 'actionable_fail' ? 'failure' : 'missing',
      applicability: 'applicable', evidence_ref: ref,
    }],
    observed_at: clock++, verified: true,
  };
}
function digest(char) {
  return char.repeat(64);
}

function harness(state, { observe = null, retry = null, readback = null } = {}) {
  let current = { state, version: state.version };
  const calls = { cas: 0, retryCi: 0, readback: 0 };
  const store = {
    async load() {
      return { state: current.state, version: current.version, digest: 'f'.repeat(64) };
    },
    async cas(next, expected) {
      calls.cas++;
      assert.equal(expected, current.version, 'CAS expected version must be current');
      validateLifecycleState(next);
      current = { state: next, version: next.version };
      return { version: next.version };
    },
  };
  const observer = {
    async observe({ state: observed, wake }) {
      return observation(observed, wake, observe == null ? {} : observe(observed, wake));
    },
    legacyPr: async () => null,
  };
  const effects = {
    async retryCi({ state: observed, action }) {
      calls.retryCi++;
      if (retry == null) throw new Error('retry unavailable');
      return retry({ state: observed, action, call: calls.retryCi });
    },
    async readbackCiRetry({ state: observed, action }) {
      calls.readback++;
      return readback == null ? { status: 'absent' } :
        readback({ state: observed, action, call: calls.readback });
    },
  };
  return {
    ports: { store, observer, effects }, calls,
    get state() { return current.state; },
  };
}
const wake = { source: 'schedule', reason: 'five_minute_scan' };

// ── durable intent → verified receipt, then no duplicate request ────────
{
  const published = publishedState();
  const missing = ciEvidence({ digest: digest('1') });
  const h = harness(published, {
    observe: () => ({ ci: missing }),
    retry: () => ({ status: 'accepted', run_id: 901, attempt: 2 }),
    readback: () => ({ status: 'absent' }),
  });
  const result = await reconcileOnce({ issue: 4528, wake, ports: h.ports });
  assert.equal(h.calls.retryCi, 1);
  const retryActions = h.state.outbox.filter((entry) => entry.action === 'ci_retry');
  assert.equal(retryActions.length, 1, 'exactly one durable retry action');
  const action = retryActions[0];
  assert.equal(action.status, 'committed');
  assert.equal(action.sha, CANDIDATE);
  assert.equal(action.evidence_generation, missing.digest);
  assert.deepEqual(action.run, { id: 901, attempt: 2, verified: true });
  assert.equal(action.receipt.outcome, 'ci_retry_requested');
  assert.equal(action.receipt.source_run_id, undefined);
  assert.equal(h.state.budgets.infrastructure_retries, 1);
  assert.equal(h.state.transitions.filter((transition) =>
    transition.kind === 'ci_retry' && transition.action_id === action.id).length, 1,
  'write-ahead retry marker is durable');
  assert.ok(result.steps.length > 0);

  // Same unresolved evidence: no second external retry.
  const again = await reconcileOnce({ issue: 4528, wake, ports: h.ports });
  assert.equal(h.calls.retryCi, 1, 'no duplicate rerun while evidence is unchanged');
  assert.equal(h.state.outbox.filter((entry) => entry.action === 'ci_retry').length, 1);
  assert.equal(again.decision, 'wait');

  // Materially new evidence (a new attempt/job generation) may retry again
  // within the cumulative budget.
  h.ports.observer.observe = async ({ state: observed, wake: activeWake }) =>
    observation(observed, activeWake, {
      ci: ciEvidence({ digest: digest('2'), ref: 'run:1/attempt:2/job:2' }),
    });
  await reconcileOnce({ issue: 4528, wake, ports: h.ports });
  assert.equal(h.calls.retryCi, 2, 'new evidence generation is a new bounded retry');
  assert.equal(h.state.budgets.infrastructure_retries, 2);
  assert.equal(h.state.outbox.filter((entry) => entry.action === 'ci_retry').length, 2);
}

// ── lost response: read back, never re-request ──────────────────────────
{
  const published = publishedState();
  let attempt = 0;
  const h = harness(published, {
    observe: () => ({ ci: ciEvidence({ digest: digest('3') }) }),
    retry: () => { throw new Error('connection reset after request'); },
    readback: () => {
      attempt++;
      return attempt < 1 ? { status: 'unavailable' } :
        { status: 'found', run_id: 902, attempt: 2 };
    },
  });
  const first = await reconcileOnce({ issue: 4528, wake, ports: h.ports });
  assert.equal(first.decision, 'recover');
  assert.equal(first.reason, 'effect_execution_unavailable');
  const pending = h.state.outbox.find((entry) => entry.action === 'ci_retry');
  assert.equal(pending.status, 'pending');
  assert.equal(h.state.transitions.filter((transition) =>
    transition.kind === 'ci_retry').length, 1, 'intent stays durable after a lost response');

  const second = await reconcileOnce({ issue: 4528, wake, ports: h.ports });
  assert.equal(h.calls.retryCi, 1, 'the external request is never repeated after uncertainty');
  const committed = h.state.outbox.find((entry) => entry.action === 'ci_retry');
  assert.equal(committed.status, 'committed');
  assert.deepEqual(committed.run, { id: 902, attempt: 2, verified: true });
  assert.equal(second.decision, 'wait');
}

// ── unknown readback keeps blocking, never a blind retry ────────────────
{
  const h = harness(publishedState(), {
    observe: () => ({ ci: ciEvidence({ digest: digest('4') }) }),
    retry: () => { throw new Error('timeout'); },
    readback: () => ({ status: 'unavailable' }),
  });
  await reconcileOnce({ issue: 4528, wake, ports: h.ports });
  for (let run = 0; run < 3; run++) {
    await reconcileOnce({ issue: 4528, wake, ports: h.ports });
  }
  assert.equal(h.calls.retryCi, 1);
  const pending = h.state.outbox.find((entry) => entry.action === 'ci_retry');
  assert.equal(pending.status, 'pending', 'unknown effect blocks until verified');
}

// ── a new attempt that is still pending never triggers another retry ────
{
  const published = publishedState();
  let poll = 0;
  const h = harness(published, {
    observe: () => {
      poll++;
      return {
        ci: poll === 1 ? ciEvidence({ digest: digest('5') }) :
          ciEvidence({ status: 'pending', digest: digest('6'), ref: 'run:1/attempt:2/job:2' }),
      };
    },
    retry: () => ({ status: 'accepted', run_id: 903, attempt: 2 }),
    readback: () => ({ status: 'absent' }),
  });
  await reconcileOnce({ issue: 4528, wake, ports: h.ports });
  assert.equal(h.calls.retryCi, 1);
  await reconcileOnce({ issue: 4528, wake, ports: h.ports });
  await reconcileOnce({ issue: 4528, wake, ports: h.ports });
  assert.equal(h.calls.retryCi, 1, 'a queued new attempt is awaited, not re-requested');
}

// ── stale-head retry is cancelled before any external request ───────────
{
  let pendingState = publishedState();
  const decision = step(pendingState, { ci: ciEvidence({ digest: digest('7') }) });
  pendingState = apply(decision);
  const retry = active(pendingState);
  assert.equal(retry.action, 'ci_retry');
  // The PR advances to a new HEAD while the retry intent is still pending.
  pendingState = validateLifecycleState({
    ...pendingState,
    version: pendingState.version + 1,
    updated_at: clock++,
    thread: { ...pendingState.thread, head_sha: NEW_HEAD },
    pr: { ...pendingState.pr, head_sha: NEW_HEAD },
    ci: null,
  });
  const h = harness(pendingState, {
    observe: () => ({}),
    retry: () => ({ status: 'accepted', run_id: 904, attempt: 2 }),
  });
  await reconcileOnce({ issue: 4528, wake, ports: h.ports });
  assert.equal(h.calls.retryCi, 0, 'a stale-head retry is never sent');
  const cancelled = h.state.outbox.find((entry) => entry.action === 'ci_retry');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.receipt.reason, 'ci_retry_stale_head');
}

// ── cumulative infrastructure budget blocks after the bounded retries ────
{
  let state = publishedState();
  for (let round = 1; round <= 3; round++) {
    const decision = step(state, {
      ci: ciEvidence({ digest: digest(String(round)), ref: 'run:' + round + '/attempt:1/job:1' }),
    });
    assert.equal(decision.reason, 'ci_evidence_missing');
    assert.equal(decision.intents.length, 1);
    assert.equal(decision.intents[0].type, 'retry_ci');
    state = apply(decision);
    const action = state.outbox.find((entry) => entry.id === decision.intents[0].action_id);
    assert.equal(action.status, 'pending');
    state = updateExecutionState(state, action.id, {
      status: 'committed',
      run: { id: 900 + round, attempt: 2, verified: true },
      receipt: {
        status: 'available', dispatch_id: action.id,
        outcome: 'ci_retry_requested', evidence_generation: action.evidence_generation,
      },
    }, clock++);
    assert.equal(state.budgets.infrastructure_retries, round);
  }
  const blocked = step(state, {
    ci: ciEvidence({ digest: digest('9'), ref: 'run:4/attempt:1/job:1' }),
  });
  assert.equal(blocked.decision, 'block');
  assert.equal(blocked.reason, 'ci_evidence_missing');
  assert.equal(blocked.intents.length, 0);
  assert.equal(blocked.nextState.phase, 'blocked');
  assert.equal(blocked.nextState.budgets.infrastructure_retries, 4);
  assert.equal(blocked.nextState.outbox.filter((entry) => entry.action === 'ci_retry').length, 3,
    'exhaustion does not create another retry action');
}

console.log('agent workflow ci-retry selftest: OK');
