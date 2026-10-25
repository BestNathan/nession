#!/usr/bin/env node
// #2327: trusted-store CLI for the E2E failure dispatch outbox. It reads the
// durable admission projection, plans the bounded Agent request, records the
// committed dispatch receipt and reconciles an ambiguous POST against the
// downstream run. It performs no dispatch itself (the workflow owns the POST).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  markFailureDispatchAmbiguous, readFailureAdmission, readFailureObservation,
  recordE2EFailureObservation, recordFailureDispatchCommitted,
} from './lib/agent/orchestration/e2e-failure-ledger.mjs';
import { buildAnalysisRequest, planFailureDispatch } from './lib/agent/orchestration/e2e-failure-dispatch.mjs';

const RUN_NAME_PREFIX = 'E2E Failure Analysis ';

function fail(message) { throw new Error('e2e failure analysis dispatch: ' + message); }
function digestOf(fingerprint) {
  if (typeof fingerprint !== 'string' || !/^e2e1:[a-f0-9]{64}$/.test(fingerprint)) fail('invalid fingerprint');
  return fingerprint.slice(5);
}

export function plan({ store, fingerprint, now = new Date().toISOString() }) {
  const admission = readFailureAdmission(store, fingerprint);
  const decision = planFailureDispatch({ state: admission.state, now });
  if (!['DISPATCH', 'RECONCILE'].includes(decision.action)) {
    return { ...decision, fingerprint, state_version: admission.version };
  }
  const latest = admission.state.latest_observation;
  if (!latest) fail('claimed fingerprint has no observation identity');
  const observation = readFailureObservation(store, fingerprint, latest.run_id, latest.run_attempt);
  const request = buildAnalysisRequest({ state: admission.state, observation });
  return { ...decision, fingerprint, state_version: admission.version, request };
}

export function reconcile({ store, fingerprint, runs, now = new Date().toISOString() }) {
  if (!Array.isArray(runs)) fail('runs must be an array');
  const decision = plan({ store, fingerprint, now });
  if (decision.action !== 'RECONCILE') return decision;
  const found = runs.find((run) => {
    if (!run || typeof run.displayTitle !== 'string') return false;
    if (run.displayTitle !== RUN_NAME_PREFIX + decision.analysis_id) return false;
    if (!Number.isSafeInteger(run.databaseId) || run.databaseId < 1) return false;
    if (!Number.isSafeInteger(run.attempt) || run.attempt < 1) return false;
    return run.event === 'workflow_dispatch' && run.status !== 'cancelled' && run.status !== 'completed';
  });
  if (!found) {
    // No run proves the original POST never landed, but a live lease may still
    // cover an in-flight dispatch notification. Only an expired lease retries.
    const state = readFailureAdmission(store, fingerprint).state;
    const leaseAt = Date.parse(state?.lease_expires_at ?? '');
    if (Number.isFinite(leaseAt) && Date.parse(now) < leaseAt) {
      return { ...decision, action: 'WAIT', reason: 'ambiguous dispatch within the claim lease' };
    }
    return { ...decision, action: 'DISPATCH', reason: 'no downstream run and the claim lease expired' };
  }
  return { action: 'ADOPT', reason: 'downstream run already exists for this analysis id',
    fingerprint, analysis_id: decision.analysis_id, state_version: decision.state_version,
    run_id: found.databaseId, run_attempt: found.attempt, request: decision.request };
}

export function ambiguous({ store, fingerprint, now = new Date().toISOString() }) {
  const receipt = markFailureDispatchAmbiguous(store, fingerprint, { now });
  return { action: 'RECONCILE_REQUIRED', fingerprint, analysis_id: receipt.state.analysis_id,
    state_version: receipt.version };
}

export function record({ store, fingerprint, runId, runAttempt, now = new Date().toISOString() }) {
  const receipt = recordFailureDispatchCommitted(store, fingerprint, {
    now, runId, runAttempt,
  });
  return { action: 'COMMITTED', fingerprint, analysis_id: receipt.state.analysis_id,
    state_version: receipt.version, run_id: runId, run_attempt: runAttempt };
}

function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-failure-dispatch-'));
  try {
    const observation = {
      authenticated: true,
      source: { repository: 'BestNathan/nession',
        workflow_path: '.github/workflows/e2e-full-regression.yml', event: 'schedule',
        branch: 'main', conclusion: 'failure', run_id: 40170599831, run_attempt: 1,
        target_sha: '1'.repeat(40), completed_at: '2026-10-25T06:51:28Z',
        acceptance_record_path: 'runs/' + '1'.repeat(40) + '/full-regression/40170599831-1.json' },
      artifact: { id: 123, digest: 'sha256:' + 'b'.repeat(64) },
      classification: 'candidate_test_failure',
      results: [{ test_id: 'terminal-attach', kind: 'assertion_failed', actionable: true,
        assertion_code: 'playwright_unexpected',
        stable_frame: 'web/src/terminal/Terminal.spec.ts:42',
        affected_invariant: 'terminal-attach', environment_specific: false }],
    };
    const now = '2026-10-25T10:00:00Z';
    const recorded = recordE2EFailureObservation(root, observation, { now });
    assert.equal(recorded.status, 'ANALYSIS_CLAIMED');
    const fingerprint = recorded.fingerprint;
    const first = plan({ store: root, fingerprint, now });
    assert.equal(first.action, 'DISPATCH');
    assert.equal(first.request.source.run_id, 40170599831);
    assert.equal(first.request.failed_tests[0].id, 'terminal-attach');
    const adopted = reconcile({ store: root, fingerprint, runs: [{
      databaseId: 4242, attempt: 1, displayTitle: 'E2E Failure Analysis ' + first.analysis_id,
      event: 'workflow_dispatch', status: 'in_progress',
    }], now: '2026-10-25T12:00:00Z' });
    assert.equal(adopted.action, 'ADOPT');
    assert.equal(adopted.run_id, 4242);
    // A fresh pending claim is a dispatch decision, not a reconcile one.
    assert.equal(reconcile({ store: root, fingerprint, runs: [], now }).action, 'DISPATCH');
    // An ambiguous POST must never license a second dispatch inside the lease.
    const ambiguousResult = ambiguous({ store: root, fingerprint, now });
    assert.equal(ambiguousResult.action, 'RECONCILE_REQUIRED');
    assert.equal(plan({ store: root, fingerprint, now }).action, 'RECONCILE');
    assert.equal(reconcile({ store: root, fingerprint, runs: [], now }).action, 'WAIT');
    assert.equal(reconcile({ store: root, fingerprint, runs: [], now: '2026-10-25T11:00:00Z' }).action,
      'DISPATCH');
    const committed = record({ store: root, fingerprint, runId: 4242, runAttempt: 1, now });
    assert.equal(committed.action, 'COMMITTED');
    assert.equal(plan({ store: root, fingerprint, now }).action, 'WAIT');
    assert.throws(() => record({ store: root, fingerprint, runId: 4243, runAttempt: 1, now }),
      /already committed/);
    console.log('e2e failure analysis dispatch CLI self-test: passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'self-test') return selfTest();
  if (command === 'plan') {
    const [store, fingerprint, out] = args;
    if (!store || !fingerprint || !out) fail('usage: plan STORE FINGERPRINT OUT');
    fs.writeFileSync(out, JSON.stringify(plan({ store, fingerprint }), null, 2) + '\n');
    return;
  }
  if (command === 'reconcile') {
    const [store, fingerprint, runsFile, out] = args;
    if (!store || !fingerprint || !runsFile || !out) fail('usage: reconcile STORE FINGERPRINT RUNS OUT');
    const runs = JSON.parse(fs.readFileSync(runsFile, 'utf8'));
    fs.writeFileSync(out, JSON.stringify(reconcile({ store, fingerprint, runs }), null, 2) + '\n');
    return;
  }
  if (command === 'ambiguous') {
    const [store, fingerprint] = args;
    if (!store || !fingerprint) fail('usage: ambiguous STORE FINGERPRINT');
    process.stdout.write(JSON.stringify(ambiguous({ store, fingerprint })) + '\n');
    return;
  }
  if (command === 'record') {
    const [store, fingerprint, runId, runAttempt] = args;
    if (!store || !fingerprint) fail('usage: record STORE FINGERPRINT RUN_ID RUN_ATTEMPT');
    const receipt = record({ store, fingerprint, runId: Number(runId), runAttempt: Number(runAttempt) });
    process.stdout.write(JSON.stringify(receipt) + '\n');
    return;
  }
  fail('usage: self-test | plan STORE FINGERPRINT OUT | reconcile STORE FINGERPRINT RUNS OUT | ambiguous STORE FINGERPRINT | record STORE FINGERPRINT RUN_ID RUN_ATTEMPT');
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    main();
  } catch (error) {
    console.error('e2e-failure-analysis-dispatch: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 2;
  }
}
