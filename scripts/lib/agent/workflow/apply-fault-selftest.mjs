// Issue #4526 SC-02 — write-ahead intent, CAS conflict, lost response and
// stale fence fixtures for the apply composition.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createApplyComposition, createScopedEffects,
} from './apply.mjs';
import { createLifecycleState } from './contract.mjs';
import { fenceGeneration, updateExecutionState } from './lifecycle.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const BASE = 'a'.repeat(40);
const authority = {
  repository: 'BestNathan/nession', event: 'workflow_dispatch',
  permission: 'write', ref: 'refs/heads/main', run_id: 9001,
};
const activation = {
  enabled: true, apply: true, v2Start: true, explicitSelection: true,
};
function fresh(issue = 4526) {
  return createLifecycleState({
    registry, issue, base_sha: BASE, developer: 'dev-cursor-01',
    reviewer: 'review-cursor-01', acceptor: 'accept-cursor-01',
    developer_sha: BASE, authority, now: 1000,
  });
}
function memoryStore(state, { conflictFirst = false } = {}) {
  let current = { state, version: state.version };
  let conflict = conflictFirst;
  const calls = { load: 0, cas: 0, conflicts: 0 };
  return {
    kind: 'memory',
    calls,
    get state() { return current.state; },
    async load() {
      calls.load++;
      return { state: current.state, version: current.version };
    },
    async cas(next, expected) {
      calls.cas++;
      if (conflict) {
        conflict = false;
        calls.conflicts++;
        return { conflict: true };
      }
      if (current.version !== expected) {
        calls.conflicts++;
        return { conflict: true };
      }
      current = { state: next, version: next.version };
      return { version: next.version };
    },
  };
}
function observer(script = []) {
  return {
    async observe({ state, wake }) {
      const patch = script.length ? script.shift()(state) : {};
      return {
        issue: state.issue,
        state_version: state.version,
        observed_at: 1,
        wake: {
          source: wake.source, reason: wake.reason,
          correlation_id: wake.correlation_id ?? null,
        },
        fencing_generation: state.thread.fencing_generation,
        pr: null, developer: null, publisher: null, ci: null,
        reviewer: null, acceptance: null, merge: null,
        ...patch,
      };
    },
  };
}
function effects(calls, { dispatchResponse = null,
  readbackResponse = null, onDispatch = null } = {}) {
  return createScopedEffects({
    async prepareDispatch() {
      calls.prepare++;
      return { issuer_run_id: 77, ticket_sha256: 'a'.repeat(64) };
    },
    async dispatch({ state, action, prepared }) {
      calls.dispatch++;
      if (onDispatch) onDispatch({ state, action, prepared });
      const current = state.outbox.find((entry) => entry.id === action.id);
      assert.equal(current.status, 'dispatching',
        'external dispatch must follow the durable write-ahead intent');
      assert.equal(current.receipt.status, 'prepared');
      return dispatchResponse ?? { status: 'accepted', run_id: 501, attempt: 1 };
    },
    async readbackDispatch() {
      calls.readback++;
      return readbackResponse ?? { status: 'absent' };
    },
    async preparePublish() { return { issuer_run_id: 77, ticket_sha256: 'a'.repeat(64) }; },
    async publish() { calls.publish++; return { status: 'accepted', run_id: 701, attempt: 1 }; },
    async readbackPublish() { return { status: 'absent' }; },
    async prepareAccept() { return { issuer_run_id: 77, ticket_sha256: 'a'.repeat(64) }; },
    async accept() { calls.accept++; return { status: 'accepted', run_id: 801, attempt: 1 }; },
    async readbackAccept() { return { status: 'absent' }; },
    async notify() { calls.notify++; },
    async retryCi() { calls.retryCi++; },
    async reingest() { calls.reingest = (calls.reingest ?? 0) + 1; },
  });
}

// ── write-ahead intent precedes the external dispatch ──────────────────
{
  const calls = { prepare: 0, dispatch: 0, readback: 0, publish: 0,
    accept: 0, notify: 0, retryCi: 0, reingest: 0 };
  let observedWriteAhead = false;
  const composition = createApplyComposition({
    store: memoryStore(fresh()),
    effects: effects(calls, {
      onDispatch: ({ state }) => {
        const action = state.outbox[0];
        observedWriteAhead = action.status === 'dispatching' &&
          action.receipt?.status === 'prepared';
      },
    }),
    observer: observer(), activation, registry,
  });
  await composition.reconcile({
    issue: 4526, wake: { source: 'manual', reason: 'start' },
  });
  assert.equal(observedWriteAhead, true);
  assert.equal(calls.dispatch, 1);
  assert.ok(calls.prepare >= 1);
}

// ── a lost dispatch response is adopted by readback, never re-POSTed ──
{
  const store = memoryStore(fresh());
  const calls = { prepare: 0, dispatch: 0, readback: 0, publish: 0,
    accept: 0, notify: 0, retryCi: 0, reingest: 0 };
  const apply = createApplyComposition({
    store,
    effects: effects(calls, {
      dispatchResponse: { status: 'ambiguous' },
      readbackResponse: { status: 'found', run_id: 555, attempt: 1 },
    }),
    observer: observer(), activation, registry,
  });
  await apply.reconcile({ issue: 4526, wake: { source: 'manual', reason: 'x' } });
  assert.equal(calls.dispatch, 1, 'exactly one external POST');
  assert.ok(calls.readback >= 1, 'readback discovered the original Run');
  assert.equal(store.state.outbox[0].status, 'dispatched');
  assert.equal(store.state.outbox[0].run.id, 555);
}

// ── a CAS conflict reloads and does not duplicate the effect ──────────
{
  const store = memoryStore(fresh(), { conflictFirst: true });
  const calls = { prepare: 0, dispatch: 0, readback: 0, publish: 0,
    accept: 0, notify: 0, retryCi: 0, reingest: 0 };
  const apply = createApplyComposition({
    store, effects: effects(calls), observer: observer(), activation, registry,
  });
  const summary = await apply.reconcile({
    issue: 4526, wake: { source: 'manual', reason: 'x' },
  });
  assert.equal(store.calls.conflicts, 1);
  assert.equal(calls.dispatch, 1, 'the effect is sent exactly once after reload');
  assert.equal(summary.decision, 'wait');
  assert.equal(store.state.outbox[0].status, 'dispatched');
}

// ── a stale fence cannot publish a result ─────────────────────────────
{
  let state = fresh();
  const action = state.outbox[0];
  state = updateExecutionState(state, action.id, {
    status: 'dispatching',
    receipt: {
      status: 'prepared', dispatch_id: action.id, issuer_run_id: 1,
      ticket_sha256: 'a'.repeat(64),
    },
    attempts: 1,
  }, 2);
  state = updateExecutionState(state, action.id, {
    status: 'dispatched', run: { id: 501, attempt: 1, verified: true },
  }, 3);
  state = fenceGeneration(state, 4);
  const store = memoryStore(state);
  const calls = { prepare: 0, dispatch: 0, readback: 0, publish: 0,
    accept: 0, notify: 0, retryCi: 0, reingest: 0 };
  const apply = createApplyComposition({
    store, effects: effects(calls),
    observer: observer([() => ({
      fencing_generation: state.thread.fencing_generation - 1,
      developer: {
        action_id: action.id, run_id: 501, attempt: 1,
        status: 'completed', outcome: 'implementation_ready',
        target_sha: 'c'.repeat(40), failure: null,
        checkpoint: {
          version: 1, commit_sha: '3'.repeat(40),
          ciphertext_sha256: '4'.repeat(64), native_session_id: 'n1',
        },
        verified: true,
      },
    })]),
    activation, registry,
  });
  const summary = await apply.reconcile({
    issue: 4526, wake: { source: 'schedule', reason: 'scan' },
  });
  assert.equal(summary.decision, 'stale');
  assert.equal(store.calls.cas, 0);
  assert.equal(calls.dispatch, 0);
  assert.equal(store.state.phase, 'authorized');
}

// ── ambiguous dispatch waits; a later readback adopts without a POST ──
{
  const store = memoryStore(fresh());
  const calls = { prepare: 0, dispatch: 0, readback: 0, publish: 0,
    accept: 0, notify: 0, retryCi: 0, reingest: 0 };
  const apply = createApplyComposition({
    store,
    effects: effects(calls, {
      dispatchResponse: { status: 'ambiguous' },
      readbackResponse: null,
    }),
    observer: observer(), activation, registry,
  });
  const first = await apply.reconcile({
    issue: 4526, wake: { source: 'manual', reason: 'x' },
  });
  assert.equal(first.decision, 'wait');
  assert.equal(calls.dispatch, 1);
  assert.equal(store.state.outbox[0].status, 'ambiguous');

  // A later wake discovers the original Run and adopts it without a second
  // external dispatch.
  const adopt = createApplyComposition({
    store,
    effects: effects(calls, {
      readbackResponse: { status: 'found', run_id: 556, attempt: 1 },
    }),
    observer: observer(), activation, registry,
  });
  await adopt.reconcile({
    issue: 4526, wake: { source: 'schedule', reason: 'scan' },
  });
  assert.equal(calls.dispatch, 1, 'no duplicate dispatch after adoption');
  assert.equal(store.state.outbox[0].status, 'dispatched');
  assert.equal(store.state.outbox[0].run.id, 556);
}

console.log('agent workflow apply fault selftest: OK');
