// Issue #4526 SC-03 — event/schedule/manual/external wakes share one
// coordinator; a wake cannot authorize start/apply/merge/SC and activation
// defaults fail closed.
import assert from 'node:assert/strict';
import { createWakeRouter } from './apply.mjs';

const BASE = 'a'.repeat(40);
const authority = {
  repository: 'BestNathan/nession', event: 'workflow_dispatch',
  permission: 'write', ref: 'refs/heads/main', run_id: 9001,
};
const activation = {
  enabled: true, apply: true, v2Start: true, explicitSelection: true,
};
const planActivation = { enabled: false };
const startRequest = {
  issue: 1, base_sha: BASE, developer_sha: BASE,
  developer: 'dev-cursor-01', reviewer: 'review-cursor-01',
  acceptor: 'accept-cursor-01', authority,
};

// ── four wake sources select the same coordinator ─────────────────────
{
  const calls = [];
  const router = createWakeRouter({
    activation: planActivation,
    async reconcile({ issue, wake, apply }) {
      calls.push({ issue, source: wake.source, reason: wake.reason, apply });
      return { decision: 'wait', source: wake.source };
    },
  });
  for (const source of ['github_event', 'schedule', 'manual', 'external']) {
    const result = await router({ source, reason: 'same_facts', issue: 42 });
    assert.equal(result.source, source);
  }
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.issue === 42 && call.reason === 'same_facts'));
  assert.ok(calls.every((call) => call.apply === false),
    'inactive activation always plans');
}

// ── activation selects apply and defaults fail closed ─────────────────
{
  const calls = [];
  const router = createWakeRouter({
    activation,
    async reconcile({ apply }) {
      calls.push(apply);
      return { decision: 'plan' };
    },
  });
  await router({ source: 'manual', reason: 'x', issue: 1 });
  assert.deepEqual(calls, [true]);
  const closed = createWakeRouter({
    activation: planActivation,
    async reconcile() { calls.push('should-not-run'); return {}; },
  });
  await assert.rejects(closed({
    source: 'manual', reason: 'x', issue: 1, apply: true,
  }), /apply is not activated/);
  assert.ok(!calls.includes('should-not-run'));
}

// ── a wake cannot authorize merge/SC/start/apply ──────────────────────
{
  const router = createWakeRouter({
    activation,
    async reconcile() { return {}; },
    async start() { throw new Error('start must not run'); },
  });
  for (const key of ['authorize', 'merge', 'sc', 'apply', 'start', 'token']) {
    await assert.rejects(router({
      source: 'external', reason: 'wake', issue: 1, [key]: true,
    }), /wake-only/);
  }
  await assert.rejects(router({
    source: 'schedule', reason: 'wake', issue: 1, start: startRequest,
  }), /manual command/);
  await assert.rejects(router({
    source: 'github_event', reason: 'wake', issue: 1, start: startRequest,
  }), /manual command/);
}

// ── an authenticated manual command may request a start ───────────────
{
  const started = [];
  const router = createWakeRouter({
    activation,
    async reconcile() { return {}; },
    async start(request) {
      started.push(request);
      return { started: true };
    },
  });
  const result = await router({
    source: 'manual', reason: 'owner_start', issue: 1, start: startRequest,
  });
  assert.equal(result.started, true);
  assert.equal(started.length, 1);
  assert.equal(started[0].issue, 1);

  const closed = createWakeRouter({
    activation: planActivation,
    async reconcile() { return {}; },
    async start() { return {}; },
  });
  await assert.rejects(closed({
    source: 'manual', reason: 'owner_start', issue: 1, start: startRequest,
  }), /v2Start is not activated/);
}

// ── a lost event is recovered by a later tick ──────────────────────────
{
  let tick = 0;
  const router = createWakeRouter({
    activation: planActivation,
    async reconcile({ wake }) {
      tick++;
      return tick === 1 ?
        { decision: 'wait', reason: 'event_missed' } :
        { decision: 'plan', reason: 'recovered_by_schedule', source: wake.source };
    },
  });
  const first = await router({ source: 'github_event', reason: 'completion', issue: 9 });
  assert.equal(first.decision, 'wait');
  const second = await router({ source: 'schedule', reason: 'scheduled_scan', issue: 9 });
  assert.equal(second.decision, 'plan');
  assert.equal(second.reason, 'recovered_by_schedule');
}

// ── redundant concurrent wakes coalesce ───────────────────────────────
{
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const router = createWakeRouter({
    activation: planActivation,
    async reconcile() {
      calls++;
      await gate;
      return { decision: 'wait' };
    },
  });
  const first = router({ source: 'schedule', reason: 'scan', issue: 3 });
  const second = router({ source: 'external', reason: 'scan', issue: 3 });
  const coalesced = await second;
  assert.equal(coalesced.coalesced, true);
  release();
  await first;
  assert.equal(calls, 1, 'one coordinator call for redundant concurrent wakes');
}

console.log('agent workflow wake-router selftest: OK');
