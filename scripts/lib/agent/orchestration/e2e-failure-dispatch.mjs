#!/usr/bin/env node
// #2327: deterministic dispatch planning for one claimed failure fingerprint.
// This module owns the decision (dispatch / wait / reconcile) and the bounded
// Agent request. It performs no GitHub call, no Store write and no model call;
// the trusted caller records intent and dispatches, then commits the receipt.
import assert from 'node:assert/strict';

const REPO = 'BestNathan/nession';
const DIGEST = /^[a-f0-9]{64}$/;

function fail(message) { throw new Error('e2e failure dispatch: ' + message); }
function analysisId(state) {
  const digest = String(state?.fingerprint ?? '').replace(/^e2e1:/, '');
  if (!DIGEST.test(digest) || !Number.isSafeInteger(state?.epoch) || state.epoch < 1) {
    fail('invalid analysis identity');
  }
  return digest + ':' + state.epoch;
}

// The durable claim is written before any external dispatch. Only a pending
// intent inside a live lease may dispatch; a committed intent never does, and
// an expired claim must be reconciled against the downstream run first.
export function planFailureDispatch({ state, now = new Date().toISOString() }) {
  if (!Number.isFinite(Date.parse(now))) fail('invalid clock');
  if (!state) return { action: 'WAIT', reason: 'no admission state' };
  if (state.status === 'issue_linked') {
    return { action: 'WAIT', reason: 'linked to an existing Bug', bug_issue: state.bug_issue ?? null };
  }
  if (state.status === 'analyzed') return { action: 'WAIT', reason: 'analysis already recorded' };
  const intent = state.dispatch_intent?.status ?? null;
  if (intent === 'committed' || intent === 'acknowledged') {
    return { action: 'WAIT', reason: 'dispatch already committed', analysis_id: analysisId(state),
      run_id: state.dispatch_run?.run_id ?? null };
  }
  if (intent === 'reconcile') {
    return { action: 'RECONCILE', reason: 'ambiguous dispatch needs a run search', analysis_id: analysisId(state) };
  }
  if (state.status === 'retryable_failure') {
    return { action: 'DISPATCH', reason: 'retryable analysis failure', analysis_id: analysisId(state) };
  }
  if (state.status !== 'claimed' && state.status !== 'in_flight') {
    return { action: 'ERROR', reason: 'unsupported admission status: ' + state.status };
  }
  const lease = Date.parse(state.lease_expires_at ?? '');
  if (!Number.isFinite(lease)) return { action: 'ERROR', reason: 'missing claim lease' };
  if (Date.parse(now) >= lease) {
    return { action: 'RECONCILE', reason: 'claim lease expired', analysis_id: analysisId(state) };
  }
  return { action: 'DISPATCH', reason: 'pending durable claim', analysis_id: analysisId(state) };
}

// Build the bounded request the read-only analysis Agent receives. Evidence is
// the trusted sanitized signature, never raw logs, trace text or Issue prose.
export function buildAnalysisRequest({ state, observation }) {
  if (!state || typeof state !== 'object') fail('admission state is required');
  if (!observation || observation.kind !== 'e2e_failure_admission_observation' ||
      observation.fingerprint !== state.fingerprint) fail('observation does not match the claim');
  const source = observation.source;
  if (!source || source.repository !== REPO ||
      source.workflow_path !== '.github/workflows/e2e-full-regression.yml') {
    fail('observation is not from the trusted Full Regression workflow');
  }
  const branch = String(source.branch ?? '');
  const environment = /^[a-z][a-z0-9-]{0,62}$/.test(branch) ? branch : 'main';
  const failed = [];
  const evidence = [];
  for (const item of observation.failure_signatures ?? []) {
    if (!item || typeof item.test_id !== 'string') fail('invalid failure signature');
    failed.push({ id: item.test_id, kind: String(item.kind || 'unknown') });
    if (item.actionable === true && item.signature) {
      const signature = item.signature;
      evidence.push({
        type: 'log',
        ref: 'signature:' + item.test_id,
        excerpt: 'kind=' + item.kind + '; code=' + String(signature.assertion_code ?? '') +
          '; frame=' + String(signature.stable_frame ?? '') +
          '; invariant=' + String(signature.affected_invariant ?? ''),
      });
    }
  }
  if (!failed.length) fail('no failed tests to analyse');
  return {
    source: {
      repository: REPO,
      workflow_name: 'E2E / Full Regression',
      run_id: source.run_id,
      run_attempt: source.run_attempt,
      target_sha: source.target_sha,
      environment_id: environment,
      completed_at: source.completed_at,
    },
    fingerprint: state.fingerprint,
    failed_tests: failed.slice(0, 64),
    evidence: evidence.slice(0, 8),
    candidate_issues: [],
  };
}

function selfTest() {
  const fingerprint = 'e2e1:' + 'a'.repeat(64);
  const claimed = {
    schema_version: 1, kind: 'e2e_failure_admission_state', fingerprint,
    version: 1, epoch: 1, status: 'claimed', analysis_id: 'a'.repeat(64) + ':1',
    lease_expires_at: '2026-10-25T10:15:00Z',
    dispatch_intent: { id: 'a'.repeat(64) + ':1', status: 'pending' },
  };
  const now = '2026-10-25T10:00:00Z';
  assert.deepEqual(planFailureDispatch({ state: claimed, now }).action, 'DISPATCH');
  assert.equal(planFailureDispatch({ state: { ...claimed, lease_expires_at: '2026-10-25T09:59:59Z' }, now }).action,
    'RECONCILE');
  assert.equal(planFailureDispatch({ state: {
    ...claimed, status: 'in_flight',
    dispatch_intent: { ...claimed.dispatch_intent, status: 'committed' },
    dispatch_run: { run_id: 77, run_attempt: 1 },
  }, now }).action, 'WAIT');
  assert.equal(planFailureDispatch({ state: { ...claimed, status: 'issue_linked' }, now }).action, 'WAIT');
  assert.equal(planFailureDispatch({ state: { ...claimed, status: 'analyzed' }, now }).action, 'WAIT');
  assert.equal(planFailureDispatch({ state: { ...claimed, status: 'mystery' }, now }).action, 'ERROR');
  assert.equal(planFailureDispatch({ state: { ...claimed,
    dispatch_intent: { ...claimed.dispatch_intent, status: 'reconcile' } }, now }).action, 'RECONCILE');

  const observation = {
    schema_version: 1, kind: 'e2e_failure_admission_observation',
    source: { repository: 'BestNathan/nession',
      workflow_path: '.github/workflows/e2e-full-regression.yml', event: 'schedule',
      branch: 'main', conclusion: 'failure', run_id: 40170599831, run_attempt: 1,
      target_sha: '1'.repeat(40), completed_at: '2026-10-25T06:51:28Z' },
    artifact: { id: 1, digest: 'sha256:' + 'b'.repeat(64) },
    fingerprint,
    classification: 'candidate_test_failure',
    result_ids: ['terminal-attach'],
    failure_signatures: [{ test_id: 'terminal-attach', kind: 'assertion_failed', actionable: true,
      signature: { assertion_code: 'playwright_unexpected',
        stable_frame: 'web/src/terminal/Terminal.spec.ts:42',
        affected_invariant: 'terminal-attach', environment_specific: false } }],
  };
  const request = buildAnalysisRequest({ state: claimed, observation });
  assert.equal(request.fingerprint, fingerprint);
  assert.equal(request.source.run_id, 40170599831);
  assert.equal(request.source.environment_id, 'main');
  assert.deepEqual(request.failed_tests, [{ id: 'terminal-attach', kind: 'assertion_failed' }]);
  assert.equal(request.evidence.length, 1);
  assert.match(request.evidence[0].excerpt, /frame=web\/src\/terminal\/Terminal\.spec\.ts:42/);
  assert.throws(() => buildAnalysisRequest({ state: claimed,
    observation: { ...observation, fingerprint: 'e2e1:' + 'c'.repeat(64) } }), /does not match/);
  assert.throws(() => buildAnalysisRequest({ state: claimed,
    observation: { ...observation, failure_signatures: [] } }), /no failed tests/);
  console.log('e2e failure dispatch policy: claim, lease, commit and bounded request fixtures passed');
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  if (process.argv[2] === 'self-test') selfTest();
  else throw new Error('usage: e2e-failure-dispatch.mjs self-test');
}
