// Issue #4482 SC-03 deterministic reconciliation/fault fixtures:
// lost wake, ambiguous dispatch, queued/running, terminal failure budgets,
// completed-but-uningested, committed-but-not-advanced, Publisher readback,
// duplicate/stale observations, CAS conflicts, unavailable observation/effect
// and identical decisions for all three wake sources.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createLifecycleState, validateLifecycleState,
} from './contract.mjs';
import { decideLifecycle, updateExecutionState } from './lifecycle.mjs';
import { reconcileOnce } from './reconcile.mjs';

const registry = JSON.parse(readFileSync('automation/agents/registry.json', 'utf8'));
const BASE = 'a'.repeat(40);
const CANDIDATE = 'c'.repeat(40);
const PR_BASE = 'b'.repeat(40);
const OBLIGATION = 'e'.repeat(64);
const CI_DIGEST = 'f'.repeat(64);
let clock = 1000;

function freshState() {
  return createLifecycleState({
    registry, issue: 4482, base_sha: BASE,
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
function prepared(id) {
  return { status: 'prepared', dispatch_id: id, issuer_run_id: 99, ticket_sha256: 'a'.repeat(64) };
}

// A faithful observer keeps reporting the same completed Run until the trusted
// ingester commits its result; it does not disappear after one poll.
function developerResultObserver(extra = null) {
  return async ({ state, wake }) => {
    const patch = extra == null ? {} : extra(state);
    const developer = state.outbox.find((entry) => entry.role === 'developer');
    if (developer != null &&
        !['committed', 'failed', 'cancelled', 'retired'].includes(developer.status)) {
      patch.developer = {
        action_id: developer.id, run_id: developer.run?.id ?? 501, attempt: 1,
        status: 'completed', outcome: 'implementation_ready',
        target_sha: CANDIDATE, failure: null,
        checkpoint: {
          version: 1, commit_sha: '1'.repeat(40),
          ciphertext_sha256: '2'.repeat(64), native_session_id: 'n1',
        },
        verified: true,
      };
    }
    return observation(state, wake, patch);
  };
}

function harness(state, { conflictFirst = false } = {}) {
  let current = { state, version: state.version };
  let conflict = conflictFirst;
  const calls = {
    cas: 0, conflict: 0, dispatch: 0, publish: 0, accept: 0,
    readbackDispatch: 0, readbackPublish: 0, readbackAccept: 0, retryCi: 0,
  };
  const script = [];
  const store = {
    async load() {
      return { state: current.state, version: current.version, digest: 'd'.repeat(64) };
    },
    async cas(next, expected) {
      calls.cas++;
      if (conflict) {
        conflict = false;
        calls.conflict++;
        return { conflict: true };
      }
      assert.equal(expected, current.version, 'CAS expected version must be current');
      validateLifecycleState(next);
      current = { state: next, version: next.version };
      return { version: next.version };
    },
  };
  const observer = {
    async observe({ state: observed, wake }) {
      const fn = script.length ? script.shift() : null;
      const patch = fn == null ? {} : await fn(observed, wake);
      if (patch === null) return null;
      return observation(observed, wake, patch);
    },
    legacyPr: async () => null,
  };
  const effects = {
    async prepareDispatch({ action }) { return prepared(action.id); },
    async dispatch() {
      calls.dispatch++;
      const response = effects.nextDispatch ?? { status: 'accepted', run_id: 500 + calls.dispatch, attempt: 1 };
      effects.nextDispatch = null;
      return response;
    },
    async readbackDispatch() {
      calls.readbackDispatch++;
      return effects.nextReadbackDispatch ?? { status: 'absent' };
    },
    async preparePublish({ action }) { return prepared(action.id); },
    async publish() {
      calls.publish++;
      const response = effects.nextPublish ?? { status: 'accepted', run_id: 700 + calls.publish, attempt: 1 };
      effects.nextPublish = null;
      return response;
    },
    async readbackPublish() {
      calls.readbackPublish++;
      return effects.nextReadbackPublish ?? { status: 'absent' };
    },
    async prepareAccept({ action }) { return prepared(action.id); },
    async accept() {
      calls.accept++;
      return effects.nextAccept ?? { status: 'accepted', run_id: 800 + calls.accept, attempt: 1 };
    },
    async readbackAccept() {
      calls.readbackAccept++;
      return effects.nextReadbackAccept ?? { status: 'absent' };
    },
    async retryCi() { calls.retryCi++; },
  };
  return {
    ports: { store, observer, effects }, calls, effects, observer,
    get state() { return current.state; },
    get version() { return current.version; },
    push(fn) { script.push(fn); },
    setConflict() { conflict = true; },
  };
}

const scheduleWake = { source: 'schedule', reason: 'five_minute_scan' };

// ── no auto-start from an empty durability index ────────────────────────
{
  const h = harness(freshState());
  h.ports.store.load = async () => ({ state: null, version: 0, digest: null });
  const result = await reconcileOnce({ issue: 4482, wake: scheduleWake, ports: h.ports });
  assert.equal(result.decision, 'ignore');
  assert.equal(result.reason, 'no_active_lifecycle');
  assert.equal(h.calls.dispatch, 0);
}

// ── lost wake: a schedule tick advances a pending intent with no event ──
{
  const h = harness(freshState());
  const result = await reconcileOnce({ issue: 4482, wake: scheduleWake, ports: h.ports });
  assert.equal(h.calls.dispatch, 1, 'the pending Developer action is dispatched');
  assert.equal(active(h.state).status, 'dispatched');
  assert.equal(active(h.state).run.id, 501);
  assert.ok(result.steps.some((step) => step.decision === 'advance'));
}

// ── ambiguous dispatch response is adopted by readback, never re-POSTed ─
{
  const h = harness(freshState());
  h.effects.nextDispatch = { status: 'ambiguous' };
  h.effects.nextReadbackDispatch = { status: 'found', run_id: 555, attempt: 1 };
  await reconcileOnce({ issue: 4482, wake: scheduleWake, ports: h.ports });
  assert.equal(h.calls.dispatch, 1, 'exactly one external dispatch POST');
  assert.ok(h.calls.readbackDispatch >= 1);
  assert.equal(active(h.state).status, 'dispatched');
  assert.equal(active(h.state).run.id, 555);
}

// ── queued/running observation never starts a duplicate model ───────────
{
  const h = harness(freshState());
  h.observer.observe = async ({ state, wake }) => {
    const action = active(state);
    if (action?.status === 'dispatched') {
      return observation(state, wake, {
        developer: {
          action_id: action.id, run_id: action.run.id, attempt: 1,
          status: 'in_progress', outcome: null, target_sha: null,
          failure: null, checkpoint: null, verified: true,
        },
      });
    }
    return observation(state, wake, {});
  };
  await reconcileOnce({ issue: 4482, wake: scheduleWake, ports: h.ports });
  assert.equal(h.calls.dispatch, 1, 'only the initial dispatch');
  assert.equal(active(h.state).status, 'dispatched');
  assert.equal(h.state.transitions.length, 0);
}

// ── terminal failures retire the action and respect the model budget ───
{
  const h = harness(freshState());
  let run = 600;
  // Every observation reports the current active Developer action as failed.
  for (let i = 0; i < 4; i++) {
    h.push((state) => {
      const action = active(state);
      if (action == null || action.role !== 'developer') return null;
      return {
        developer: {
          action_id: action.id, run_id: action.run?.id ?? action.attempts + 600,
          attempt: 1, status: 'completed', outcome: 'failed',
          target_sha: null,
          failure: { category: 'model', code: 'provider_crash' },
          checkpoint: null, verified: true,
        },
      };
    });
  }
  const result = await reconcileOnce({
    issue: 4482, wake: scheduleWake, ports: h.ports,
    config: { max_model_retries: 1 },
  });
  assert.equal(h.state.phase, 'blocked');
  assert.equal(h.state.blocker.reason, 'model_budget_exhausted');
  assert.equal(h.state.budgets.model_retries, 2);
  assert.equal(h.calls.dispatch, 1, 'the successor was dispatched exactly once');
  assert.ok(result.steps.some((step) => step.decision === 'block'));
}

// ── completed-but-uningested result commits once; replay is idempotent ──
{
  const h = harness(freshState());
  h.observer.observe = developerResultObserver();
  await reconcileOnce({ issue: 4482, wake: scheduleWake, ports: h.ports });
  assert.equal(h.calls.publish, 1, 'the Publisher intent is executed once');
  assert.equal(h.state.phase, 'publishing');
  const versionsAfterFirst = h.version;
  const developerAction = h.state.outbox.find((entry) => entry.role === 'developer');
  // Duplicate delivery after the transition is an idempotent replay.
  const duplicate = decideLifecycle(h.state, observation(h.state, scheduleWake, {
    developer: {
      action_id: developerAction.id, run_id: developerAction.run.id, attempt: 1,
      status: 'completed', outcome: 'implementation_ready',
      target_sha: CANDIDATE, failure: null,
      checkpoint: {
        version: 1, commit_sha: '1'.repeat(40),
        ciphertext_sha256: '2'.repeat(64), native_session_id: 'n1',
      },
      verified: true,
    },
  }));
  assert.equal(duplicate.decision, 'replay');
  assert.equal(duplicate.nextState, null);
  await reconcileOnce({ issue: 4482, wake: scheduleWake, ports: h.ports });
  assert.equal(h.version, versionsAfterFirst, 'a replayed wake performs no Git write');
}

// ── committed-but-not-advanced: a persisted Publisher intent is resumed ─
{
  const h = harness(freshState());
  h.observer.observe = developerResultObserver();
  // First run commits the transition but the effect fails after write-ahead.
  h.effects.preparePublish = async () => { throw new Error('temporary'); };
  let result = await reconcileOnce({ issue: 4482, wake: scheduleWake, ports: h.ports });
  assert.equal(result.decision, 'recover');
  assert.equal(result.reason, 'effect_execution_unavailable');
  assert.equal(h.state.phase, 'publishing');
  const publishAction = active(h.state);
  assert.equal(publishAction.status, 'pending');
  const before = h.version;
  h.effects.preparePublish = async (action) => prepared(action.id);
  result = await reconcileOnce({ issue: 4482, wake: scheduleWake, ports: h.ports });
  assert.equal(h.calls.publish, 1);
  assert.equal(active(h.state).status, 'dispatched');
  assert.ok(h.version > before);
  assert.equal(h.state.phase, 'publishing');
}

// ── Publisher side-effect readback adopts one PR; no duplicate publish ──
{
  const h = harness(freshState());
  // Drive to publishing, then make the Publisher action ambiguous.
  h.observer.observe = developerResultObserver();
  h.effects.nextPublish = { status: 'ambiguous' };
  await reconcileOnce({ issue: 4482, wake: scheduleWake, ports: h.ports });
  const publisher = active(h.state);
  assert.equal(publisher.role, 'publisher');
  assert.equal(publisher.status, 'ambiguous');
  const posts = h.calls.publish;
  h.effects.nextReadbackPublish = {
    status: 'found', run_id: 777, attempt: 1,
    pr: {
      number: 4500, head_sha: CANDIDATE, base_sha: PR_BASE,
      state: 'open', merged_sha: null,
    },
  };
  await reconcileOnce({ issue: 4482, wake: scheduleWake, ports: h.ports });
  assert.equal(h.calls.publish, posts, 'no second publish after readback');
  assert.equal(active(h.state).status, 'dispatched');
  assert.equal(active(h.state).run.id, 777);
}

// ── stale observation version causes reload, not a write ────────────────
{
  let stale = freshState();
  const action = active(stale);
  stale = updateExecutionState(stale, action.id, {
    status: 'dispatching', receipt: prepared(action.id), attempts: 1,
  }, clock++);
  stale = updateExecutionState(stale, action.id, {
    status: 'dispatched', run: { id: 501, attempt: 1, verified: true },
  }, clock++);
  const before = stale.version;
  const h = harness(stale);
  let first = true;
  h.observer.observe = async ({ state, wake }) => {
    if (first) {
      first = false;
      return observation(state, wake, { state_version: state.version - 1 });
    }
    return observation(state, wake, {});
  };
  const result = await reconcileOnce({ issue: 4482, wake: scheduleWake, ports: h.ports });
  assert.ok(result.steps.some((step) => step.decision === 'stale_observation'));
  assert.equal(h.calls.cas, 0);
  assert.equal(h.state.version, before);
}

// ── CAS conflict reloads and re-observes; one effect only ───────────────
{
  const h = harness(freshState(), { conflictFirst: true });
  const result = await reconcileOnce({ issue: 4482, wake: scheduleWake, ports: h.ports });
  assert.ok(result.steps.some((step) =>
    step.decision === 'cas_conflict' || step.decision === 'effect_not_committed'));
  assert.equal(h.calls.dispatch, 1);
  assert.equal(h.state.outbox[0].status, 'dispatched');
}

// ── unavailable observation is recoverable, never a pass or failure ─────
{
  const h = harness(freshState());
  h.observer.observe = async () => { throw new Error('GitHub 503'); };
  const result = await reconcileOnce({ issue: 4482, wake: scheduleWake, ports: h.ports });
  assert.equal(result.decision, 'recover');
  assert.equal(result.reason, 'observation_unavailable');
  assert.equal(h.calls.cas, 0);
}

// ── unavailable effect keeps the write-ahead intent for a later readback ─
{
  const h = harness(freshState());
  h.effects.dispatch = async () => { throw new Error('API timeout'); };
  const result = await reconcileOnce({ issue: 4482, wake: scheduleWake, ports: h.ports });
  assert.equal(result.decision, 'recover');
  assert.equal(result.reason, 'effect_execution_unavailable');
  assert.equal(h.state.outbox[0].status, 'dispatching');
  assert.equal(h.calls.dispatch, 0);
}

// ── CI missing recovery is bounded and blocks on budget ─────────────────
{
  const h = harness(freshState());
  h.observer.observe = async ({ state, wake }) => {
    const patch = {};
    const developer = state.outbox.find((entry) => entry.role === 'developer');
    if (developer != null &&
        !['committed', 'failed', 'cancelled', 'retired'].includes(developer.status)) {
      patch.developer = {
        action_id: developer.id, run_id: developer.run?.id ?? 501, attempt: 1,
        status: 'completed', outcome: 'implementation_ready',
        target_sha: CANDIDATE, failure: null,
        checkpoint: {
          version: 1, commit_sha: '1'.repeat(40),
          ciphertext_sha256: '2'.repeat(64), native_session_id: 'n1',
        },
        verified: true,
      };
    }
    const publisher = state.outbox.find((entry) => entry.role === 'publisher');
    if (publisher?.status === 'dispatched') {
      patch.publisher = {
        action_id: publisher.id, run_id: publisher.run.id, attempt: 1,
        status: 'completed', outcome: 'published',
        pr: {
          number: 4500, head_sha: CANDIDATE, base_sha: PR_BASE,
          state: 'open', merged_sha: null,
        },
        failure: null, readback: null, verified: true,
      };
    }
    if (state.phase === 'ci_checking') {
      patch.ci = {
        head_sha: state.thread.head_sha, obligation_sha256: OBLIGATION,
        status: 'missing', digest: CI_DIGEST,
        checks: [{
          name: 'quality', workflow: 'ci-quality', conclusion: 'cancelled',
          applicability: 'applicable', evidence_ref: null,
        }],
        observed_at: clock++, verified: true,
      };
    }
    return observation(state, wake, patch);
  };
  const result = await reconcileOnce({
    issue: 4482, wake: scheduleWake, ports: h.ports,
    config: { max_infrastructure_retries: 0 },
  });
  assert.equal(h.state.phase, 'blocked');
  assert.equal(h.state.blocker.reason, 'ci_evidence_missing');
  assert.ok(result.steps.some((step) => step.decision === 'block'));
}

// ── all wake sources select the same decision logic ────────────────────
{
  const state = freshState();
  const facts = { developer: null, publisher: null, ci: null, reviewer: null,
    acceptance: null, merge: null, pr: null };
  const decisions = ['github_event', 'schedule', 'external', 'manual'].map((source) =>
    decideLifecycle(state, observation(state, { source, reason: 'same_facts' }, facts)));
  for (const decision of decisions.slice(1)) {
    assert.deepEqual(decision, decisions[0]);
  }
  assert.equal(decisions[0].decision, 'advance');
  assert.equal(decisions[0].intents[0].role, 'developer');
}

// ── v1 durability is migrated explicitly inside Reconcile ───────────────
{
  const { startDevelopment } = await import('../orchestration/outbox.mjs');
  const v1 = startDevelopment(registry, {
    issue: 4482, sha: BASE, developer: 'dev-cursor-01',
    reviewer: 'review-cursor-01', acceptor: 'accept-cursor-01',
  }, {
    repository: 'BestNathan/nession', event: 'workflow_dispatch',
    permission: 'write', ref: 'refs/heads/main', run_id: 1001,
  });
  const h = harness(v1);
  const result = await reconcileOnce({ issue: 4482, wake: scheduleWake, ports: h.ports });
  assert.equal(result.migrated, true);
  assert.equal(h.state.schema_version, 2);
  assert.equal(h.state.migration.from_version, v1.version);
  assert.equal(h.calls.dispatch, 1);
  assert.equal(h.state.phase, 'authorized');
}

console.log('agent workflow reconcile selftest: OK');
