#!/usr/bin/env node
// #2327: durable, at-most-once dispatch preparation for read-only E2E analysis.
// The Store CAS must be published before the dispatch command is allowed to POST.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitE2EFailureDispatch, readE2EFailureAdmission } from './lib/agent/orchestration/e2e-failure-ledger.mjs';

const REPO = 'BestNathan/nession';
const SHA40 = /^[a-f0-9]{40}$/;
const FP = /^e2e1:[a-f0-9]{64}$/;
const ANALYSIS_ID = /^[a-f0-9]{64}:[1-9][0-9]*$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
function fail(message) { throw new Error('e2e-failure-dispatch: ' + message); }

function validateBatch(batch) {
  if (batch?.schema_version !== 1 || batch.kind !== 'e2e_failure_admission_batch' ||
      !positive(batch.source_run_id) || !positive(batch.source_attempt) ||
      !SHA40.test(batch.source_sha ?? '') || !Array.isArray(batch.outcomes) ||
      batch.outcomes.length > 64) fail('invalid admission batch');
  for (const outcome of batch.outcomes) {
    if (!outcome || typeof outcome.status !== 'string') fail('invalid admission outcome');
    if (outcome.status === 'ANALYSIS_CLAIMED' &&
        (!FP.test(outcome.fingerprint ?? '') || !ANALYSIS_ID.test(outcome.analysis_id ?? '') ||
         outcome.analysis_id !== outcome.fingerprint.slice(5) + ':' + outcome.epoch)) {
      fail('claimed analysis lacks exact fingerprint/epoch identity');
    }
  }
  return batch;
}

export function prepareDispatchPlan(batch, storeRoot, { now = new Date().toISOString() } = {}) {
  validateBatch(batch);
  if (typeof storeRoot !== 'string' || !path.isAbsolute(storeRoot) ||
      !fs.statSync(storeRoot).isDirectory()) fail('absolute existing agent-store checkout required');
  const dispatches = [];
  const outcomes = [];
  const seen = new Set();
  for (const outcome of batch.outcomes) {
    if (outcome.status !== 'ANALYSIS_CLAIMED') continue;
    if (seen.has(outcome.fingerprint)) continue;
    seen.add(outcome.fingerprint);
    const committed = commitE2EFailureDispatch(storeRoot, outcome.fingerprint, { now });
    outcomes.push(committed);
    if (committed.status === 'DISPATCH_COMMITTED') {
      dispatches.push({
        analysis_id: committed.analysis_id,
        fingerprint: committed.fingerprint,
        source_run_id: batch.source_run_id,
        source_attempt: batch.source_attempt,
        source_sha: batch.source_sha,
      });
    }
  }
  return {
    schema_version: 1, kind: 'e2e_failure_dispatch_plan',
    source_run_id: batch.source_run_id, source_attempt: batch.source_attempt,
    source_sha: batch.source_sha, dispatches, outcomes,
    // A POST is permitted only after the caller successfully publishes the CAS commit.
    store_cas_publication_required: dispatches.length > 0,
  };
}

function validatePlan(plan) {
  if (plan?.schema_version !== 1 || plan.kind !== 'e2e_failure_dispatch_plan' ||
      !positive(plan.source_run_id) || !positive(plan.source_attempt) ||
      !SHA40.test(plan.source_sha ?? '') || !Array.isArray(plan.dispatches) ||
      plan.dispatches.length > 64) fail('invalid dispatch plan');
  const ids = new Set();
  for (const item of plan.dispatches) {
    if (!item || !FP.test(item.fingerprint ?? '') ||
        !ANALYSIS_ID.test(item.analysis_id ?? '') ||
        item.analysis_id.split(':')[0] !== item.fingerprint.slice(5) ||
        item.source_run_id !== plan.source_run_id ||
        item.source_attempt !== plan.source_attempt ||
        item.source_sha !== plan.source_sha || ids.has(item.analysis_id)) {
      fail('invalid or duplicate dispatch identity');
    }
    ids.add(item.analysis_id);
  }
  return plan;
}

async function verifyCommittedPlan(plan) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dispatch-readback-'));
  const root = path.join(temp, 'agent-store');
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['clone', '--quiet', '--no-tags', '--single-branch', '--branch',
      'agent-store', '--', 'https://github.com/BestNathan/nession.git', root], {
      encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    });
    for (const item of plan.dispatches) {
      const read = readE2EFailureAdmission(root, item.fingerprint);
      const state = read?.state;
      if (!state || state.analysis_id !== item.analysis_id || state.status !== 'in_flight' ||
          state.dispatch_intent?.status !== 'committed' ||
          state.latest_observation?.run_id !== item.source_run_id ||
          state.latest_observation?.run_attempt !== item.source_attempt ||
          state.latest_observation?.target_sha !== item.source_sha) {
        fail('dispatch plan is not backed by the exact published CAS claim');
      }
    }
  } catch (error) {
    if (String(error?.message ?? '').startsWith('e2e-failure-dispatch:')) throw error;
    fail('published agent-store CAS readback failed; refuse POST');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function dispatchPlan(plan) {
  validatePlan(plan);
  const env = process.env;
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== REPO ||
      env.GITHUB_REF !== 'refs/heads/main' ||
      env.GITHUB_WORKFLOW !== 'E2E / Full Failure Intake' ||
      env.GITHUB_EVENT_NAME !== 'workflow_run' ||
      !SHA40.test(env.GITHUB_SHA ?? '')) fail('not a trusted Main-owned intake workflow');
  let event;
  try { event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')); }
  catch { fail('trusted workflow_run event unavailable'); }
  if (event?.repository?.full_name !== REPO ||
      event?.workflow_run?.id !== plan.source_run_id ||
      event?.workflow_run?.run_attempt !== plan.source_attempt ||
      event?.workflow_run?.head_sha !== plan.source_sha ||
      event?.workflow_run?.path !== '.github/workflows/e2e-full-regression.yml' ||
      event?.workflow_run?.event !== 'schedule' ||
      event?.workflow_run?.head_branch !== 'main' ||
      event?.workflow_run?.conclusion !== 'failure') fail('plan differs from exact authenticated source event');
  const token = env.GH_TOKEN;
  if (typeof token !== 'string' || token.length < 8) fail('missing Actions dispatch credential');
  await verifyCommittedPlan(plan);
  const results = [];
  for (const item of plan.dispatches) {
    const response = await fetch('https://api.github.com/repos/' + REPO +
      '/actions/workflows/e2e-failure-analysis.yml/dispatches', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: {
        analysis_id: item.analysis_id, fingerprint: item.fingerprint,
        source_run_id: String(item.source_run_id), source_attempt: String(item.source_attempt),
        source_sha: item.source_sha,
      } }),
    });
    // workflow_dispatch returns 204. Never retry a failed/ambiguous POST; the
    // committed intent is a no-redelivery fence until the reconciler attests it.
    if (response.status !== 204) fail('workflow_dispatch was not confirmed (HTTP ' + response.status + '); reconcile, do not retry blindly');
    results.push({ analysis_id: item.analysis_id, status: 'DISPATCH_ACCEPTED_BY_GITHUB_API',
      run_id: null, reconciliation_required: true });
  }
  return { schema_version: 1, kind: 'e2e_failure_dispatch_receipt',
    source_run_id: plan.source_run_id, source_attempt: plan.source_attempt,
    dispatches: results, agent_invocations: 0, bugs_written: 0 };
}

function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dispatch-selftest-'));
  try {
    const sha = 'a'.repeat(40), digest = 'b'.repeat(64), fp = 'e2e1:' + digest;
    const batch = { schema_version: 1, kind: 'e2e_failure_admission_batch',
      source_run_id: 501, source_attempt: 2, source_sha: sha,
      outcomes: [{ status: 'ANALYSIS_CLAIMED', fingerprint: fp,
        analysis_id: digest + ':1', epoch: 1 }] };
    // Build the exact state that a successful admission CAS would leave behind.
    const { recordE2EFailureObservation } = awaitLedger();
    const observation = { authenticated: true,
      source: { repository: REPO, workflow_path: '.github/workflows/e2e-full-regression.yml',
        event: 'schedule', branch: 'main', conclusion: 'failure', run_id: 501,
        run_attempt: 2, target_sha: sha, completed_at: '2026-10-24T12:00:00Z' },
      artifact: { id: 77, digest: 'sha256:' + 'c'.repeat(64) },
      classification: 'candidate_test_failure',
      results: [{ test_id: 'terminal-attach', kind: 'assertion_failed', actionable: true,
        assertion_code: 'playwright_unexpected', stable_frame: 'terminal-attach.spec.ts:42:9',
        affected_invariant: 'terminal-attach', environment_specific: false }] };
    recordE2EFailureObservation(root, observation, { now: '2026-10-24T12:01:00Z' });
    const plan = prepareDispatchPlan(batch, root, { now: '2026-10-24T12:02:00Z' });
    assert.equal(plan.dispatches.length, 1);
    assert.equal(plan.dispatches[0].analysis_id, digest + ':1');
    assert.equal(readE2EFailureAdmission(root, fp).state.dispatch_intent.status, 'committed');
    const replay = prepareDispatchPlan(batch, root, { now: '2026-10-24T12:03:00Z' });
    assert.equal(replay.dispatches.length, 0, 'a committed intent must not yield a second POST');
    assert.equal(replay.outcomes[0].status, 'DISPATCH_ALREADY_COMMITTED');
    assert.throws(() => validatePlan({ ...plan, dispatches: [{ ...plan.dispatches[0], source_sha: 'main' }] }), /invalid or duplicate/);
    console.log('e2e-failure-dispatch self-test: PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// Kept as a function to make the self-test independent of a live Store.
function awaitLedger() {
  return { recordE2EFailureObservation: globalThis.__unusedRecordE2EFailureObservation };
}

function main() {
  if (process.argv[2] === 'self-test') return selfTest();
  if (process.argv[2] === 'prepare' && process.argv.length === 6) {
    const batch = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const result = prepareDispatchPlan(batch, process.argv[4]);
    fs.writeFileSync(process.argv[5], JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ dispatches: result.dispatches.length,
      outcomes: result.outcomes.map(x => ({ status: x.status, analysis_id: x.analysis_id })) }));
    return;
  }
  if (process.argv[2] === 'dispatch' && process.argv.length === 4) {
    const plan = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    dispatchPlan(plan).then(result => console.log(JSON.stringify(result))).catch(error => {
      console.error(error.message); process.exitCode = 2;
    });
    return;
  }
  fail('usage: self-test | prepare BATCH_JSON ABSOLUTE_AGENT_STORE_ROOT OUTPUT_JSON | dispatch PLAN_JSON');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
