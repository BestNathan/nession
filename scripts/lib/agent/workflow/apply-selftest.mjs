// Issue #4526 SC-01 — one production composition, plan cannot mutate,
// unauthorized apply/start and duplicate ownership fail closed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createApplyComposition, createAuthorizedStart, createScopedEffects,
} from './apply.mjs';
import { createLifecycleState } from './contract.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const BASE = 'a'.repeat(40);
const authority = {
  repository: 'BestNathan/nession', event: 'workflow_dispatch',
  permission: 'write', ref: 'refs/heads/main', run_id: 9001,
};
const activation = {
  enabled: true, apply: true, v2Start: true, explicitSelection: true,
};
const planActivation = { enabled: false };

function memoryStore(state = null) {
  let current = state == null ? { state: null, version: 0 } : {
    state, version: state.version,
  };
  const calls = { load: 0, cas: 0, conflicts: 0 };
  return {
    kind: 'memory',
    calls,
    get state() { return current.state; },
    get version() { return current.version; },
    async load() {
      calls.load++;
      return { state: current.state, version: current.version };
    },
    async cas(next, expected) {
      calls.cas++;
      if (current.version !== expected) {
        calls.conflicts++;
        return { conflict: true };
      }
      if (next.version !== expected + 1) throw new Error('non-contiguous');
      current = { state: next, version: next.version };
      return { version: next.version };
    },
  };
}
function observer() {
  return {
    async observe({ state, wake }) {
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
      };
    },
  };
}
function effects(calls) {
  const accepted = (runId) => ({ status: 'accepted', run_id: runId, attempt: 1 });
  const absent = async () => ({ status: 'absent' });
  return createScopedEffects({
    async prepareDispatch() {
      calls.prepare++;
      return { issuer_run_id: 77, ticket_sha256: 'a'.repeat(64) };
    },
    async dispatch() { calls.dispatch++; return accepted(501); },
    async readbackDispatch() { calls.readback++; return { status: 'absent' }; },
    async preparePublish() { return { issuer_run_id: 77, ticket_sha256: 'a'.repeat(64) }; },
    async publish() { calls.publish++; return accepted(701); },
    async readbackPublish() { return { status: 'absent' }; },
    async prepareAccept() { return { issuer_run_id: 77, ticket_sha256: 'a'.repeat(64) }; },
    async accept() { calls.accept++; return accepted(801); },
    async readbackAccept() { return { status: 'absent' }; },
    async notify() { calls.notify++; },
    async retryCi() { calls.retryCi++; },
    async readbackCiRetry() { return { status: 'absent' }; },
    async reingest() { calls.reingest = (calls.reingest ?? 0) + 1; },
  });
}
function fresh(issue = 4526) {
  return createLifecycleState({
    registry, issue, base_sha: BASE, developer: 'dev-cursor-01',
    reviewer: 'review-cursor-01', acceptor: 'accept-cursor-01',
    developer_sha: BASE, authority, now: 1000,
  });
}

// ── plan is the default and cannot mutate ──────────────────────────────
{
  const store = memoryStore(fresh(4526));
  const calls = { prepare: 0, dispatch: 0, readback: 0, publish: 0,
    accept: 0, notify: 0, retryCi: 0, reingest: 0 };
  const plan = createApplyComposition({
    store, observer: observer(), activation: planActivation, registry,
  });
  assert.equal(plan.mode, 'plan');
  const summary = await plan.reconcile({
    issue: 4526, wake: { source: 'schedule', reason: 'scan' },
  });
  assert.equal(summary.decision, 'plan');
  assert.equal(store.calls.cas, 0, 'plan cannot write the Store');
  assert.equal(calls.dispatch, 0, 'plan cannot dispatch');
  await assert.rejects(plan.reconcile({
    issue: 4526, wake: { source: 'manual', reason: 'x' }, apply: true,
  }), /apply is not activated/);
  await assert.rejects(plan.start({
    issue: 4526, base_sha: BASE, developer_sha: BASE,
    developer: 'dev-cursor-01', reviewer: 'review-cursor-01',
    acceptor: 'accept-cursor-01', authority,
  }), /v2Start is not activated/);
}

// ── authorized start and eligible apply share one reconcileOnce path ───
{
  const store = memoryStore();
  const calls = { prepare: 0, dispatch: 0, readback: 0, publish: 0,
    accept: 0, notify: 0, retryCi: 0, reingest: 0 };
  const apply = createApplyComposition({
    store, effects: effects(calls), observer: observer(),
    activation, registry,
  });
  assert.equal(apply.mode, 'apply');
  const started = await apply.start({
    issue: 4526, base_sha: BASE, developer_sha: BASE,
    developer: 'dev-cursor-01', reviewer: 'review-cursor-01',
    acceptor: 'accept-cursor-01', authority,
  });
  assert.equal(started.version, 1);
  assert.equal(store.calls.cas, 1);
  const summary = await apply.reconcile({
    issue: 4526, wake: { source: 'manual', reason: 'start' },
  });
  assert.equal(summary.decision, 'wait');
  assert.equal(calls.dispatch, 1, 'exactly one eligible dispatch');
  assert.equal(store.calls.cas, 3, 'write-ahead + verified Run CAS');
  const dispatched = store.state.outbox.find((entry) => entry.status === 'dispatched');
  assert.ok(dispatched);
  assert.equal(dispatched.run.id, 501);
  await apply.close();
}

// ── a wake is not a start/apply authorization ─────────────────────────
{
  const store = memoryStore();
  const calls = { prepare: 0, dispatch: 0, readback: 0, publish: 0,
    accept: 0, notify: 0, retryCi: 0, reingest: 0 };
  const apply = createApplyComposition({
    store, effects: effects(calls), observer: observer(),
    activation, registry,
  });
  await assert.rejects(apply.route({
    source: 'external', reason: 'wake', issue: 4526, authorize: true,
  }), /wake-only/);
  await assert.rejects(apply.route({
    source: 'schedule', reason: 'wake', issue: 4526,
    start: {
      issue: 4526, base_sha: BASE, developer_sha: BASE,
      developer: 'dev-cursor-01', reviewer: 'review-cursor-01',
      acceptor: 'accept-cursor-01', authority,
    },
  }), /manual command/);
}

// ── V1/V2 ownership is mutually exclusive ─────────────────────────────
{
  const v1 = {
    schema_version: 1, issue: 4526, version: 1, phase: 'ready',
    target_sha: null, repair_attempts: 0, transitions: [],
    assignments: {
      developer: 'dev-cursor-01', reviewer: 'review-cursor-01',
      acceptor: 'accept-cursor-01',
    },
    outbox: [],
  };
  const store = memoryStore(v1);
  const start = createAuthorizedStart({
    store, registry, activation, now: 1,
  });
  await assert.rejects(start({
    issue: 4526, base_sha: BASE, developer_sha: BASE,
    developer: 'dev-cursor-01', reviewer: 'review-cursor-01',
    acceptor: 'accept-cursor-01', authority,
  }), /already has a durable lifecycle/);
  assert.equal(store.calls.cas, 0);
}

// ── credentials/model material cannot enter the effect boundary ────────
{
  const calls = { prepare: 0, dispatch: 0, readback: 0, publish: 0,
    accept: 0, notify: 0, retryCi: 0, reingest: 0 };
  const full = effects(calls);
  assert.throws(() => createScopedEffects({
    ...full, api_key: 'secret',
  }), /model\/credential/);
  assert.throws(() => createScopedEffects({
    ...full, model: 'gpt',
  }), /model\/credential/);
  const missing = { ...full };
  delete missing.dispatch;
  assert.throws(() => createScopedEffects(missing), /missing effect adapter dispatch/);
}

console.log('agent workflow apply selftest: OK');
