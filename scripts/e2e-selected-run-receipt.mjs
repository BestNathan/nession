#!/usr/bin/env node
// Selected-PR E2E run receipt (#1866 SC-02).
//
// "Only the obligated IDs ran, in one Playwright process, on one runtime" was
// not observable from CI metadata: the Acceptance harness compacts run
// evidence and never reads artifacts, so the per-ID Passes were visible while
// the one-runtime measurement was not. The selected E2E job now counts the
// full-stack provisions its own run made and writes this bounded receipt into
// the job log, the same channel as the Metrics replay denial, Run Store policy
// and Acceptance batch receipts.
//
// The producer runs as target code, so the receipt is untrusted until the
// trusted collector binds it to the exact Run/Attempt/SHA and to the completed
// `E2E / Tests` job that emitted it.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export const E2E_SELECTED_RUN_LOG_PREFIX = 'E2E_SELECTED_RUN_RECEIPT_V1 ';
export const E2E_SELECTED_WORKFLOW = '.github/workflows/e2e-tests.yml';
export const E2E_SELECTED_WORKFLOW_NAME = 'E2E / Tests';
export const E2E_SELECTED_JOB = 'e2e';
export const E2E_SELECTED_STEP = 'Run E2E tests';
// Only a pull_request run exercises the selected path; a push run is the full
// regression and reports through its own canonical evidence.
export const E2E_SELECTED_EVENTS = Object.freeze(['pull_request']);
export const REPO = 'BestNathan/nession';
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const POS = (x) => Number.isSafeInteger(x) && x > 0;
const MAX_IDS = 64;

function normalizeWorkflowPath(value) {
  return String(value ?? '').replace(/@refs\/[^\s]+$/, '');
}

function positiveInt(x) {
  const parsed = Number(x);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function makeE2eSelectedRunReceipt({ env, runId, runAttempt, sha, selectedIds, provisions }) {
  const run = positiveInt(runId ?? env?.GITHUB_RUN_ID);
  const attempt = positiveInt(runAttempt ?? env?.GITHUB_RUN_ATTEMPT);
  const ids = Array.isArray(selectedIds) ? [...new Set(selectedIds)] : [];
  if (env?.GITHUB_REPOSITORY !== REPO || run === null || attempt === null ||
      !SHA.test(String(sha ?? '')) || ids.length === 0 || ids.length > MAX_IDS ||
      ids.some((id) => !ID.test(String(id))) || ids.length !== selectedIds.length ||
      !POS(provisions) || provisions > MAX_IDS) {
    return null;
  }
  return Object.freeze({
    schema_version: 1,
    kind: 'e2e_selected_run',
    repository: REPO,
    workflow: E2E_SELECTED_WORKFLOW,
    run_id: run,
    run_attempt: attempt,
    sha,
    selected_ids: Object.freeze(ids.sort()),
    selected_count: ids.length,
    // Measured by the runtime's own provision counter, one line per resolved
    // full-stack stack. One selected-run invocation must resolve exactly one.
    provisioned_runtimes: provisions,
  });
}

export function validateE2eSelectedRunReceipt(receipt) {
  if (receipt?.schema_version !== 1 || receipt.kind !== 'e2e_selected_run' ||
      receipt.repository !== REPO || receipt.workflow !== E2E_SELECTED_WORKFLOW ||
      !POS(receipt.run_id) || !POS(receipt.run_attempt) ||
      !SHA.test(receipt.sha ?? '') ||
      !Array.isArray(receipt.selected_ids) || receipt.selected_ids.length === 0 ||
      receipt.selected_ids.length > MAX_IDS ||
      receipt.selected_ids.some((id) => !ID.test(String(id))) ||
      new Set(receipt.selected_ids).size !== receipt.selected_ids.length ||
      !POS(receipt.selected_count) ||
      receipt.selected_count !== receipt.selected_ids.length ||
      !POS(receipt.provisioned_runtimes) ||
      receipt.provisioned_runtimes > MAX_IDS) {
    throw Error('invalid selected E2E run receipt');
  }
  const allowed = new Set(['schema_version', 'kind', 'repository', 'workflow',
    'run_id', 'run_attempt', 'sha',
    'selected_ids', 'selected_count', 'provisioned_runtimes']);
  if (Object.keys(receipt).some((key) => !allowed.has(key))) {
    throw Error('unexpected selected E2E run receipt fields');
  }
  return receipt;
}

// The receipt is an untrusted claim until GitHub REST independently binds it to
// the exact Run/Attempt/SHA and to the completed job and step that emitted it.
export function attestE2eSelectedRunReceipt(receipt, run, job) {
  validateE2eSelectedRunReceipt(receipt);
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const runSteps = steps.filter((step) => step?.name === E2E_SELECTED_STEP);
  if (run?.id !== receipt.run_id ||
      run?.run_attempt !== receipt.run_attempt ||
      run?.head_sha !== receipt.sha ||
      !E2E_SELECTED_EVENTS.includes(run?.event) ||
      run?.name !== E2E_SELECTED_WORKFLOW_NAME ||
      normalizeWorkflowPath(run?.path) !== E2E_SELECTED_WORKFLOW ||
      run?.repository?.full_name !== REPO ||
      run?.head_repository?.full_name !== REPO ||
      run?.status !== 'completed' ||
      !['success', 'failure'].includes(run?.conclusion) ||
      job?.name !== E2E_SELECTED_JOB ||
      job?.run_id !== receipt.run_id ||
      job?.run_attempt !== receipt.run_attempt ||
      job?.head_sha !== receipt.sha ||
      job?.status !== 'completed' ||
      job?.conclusion !== 'success' ||
      runSteps.length !== 1 ||
      runSteps[0].conclusion !== 'success') {
    throw Error('selected E2E run receipt Run/Attempt/job provenance mismatch');
  }
  return Object.freeze({
    kind: 'verified_e2e_selected_run',
    run_id: receipt.run_id,
    run_attempt: receipt.run_attempt,
    sha: receipt.sha,
    event: run.event,
    branch: run.head_branch ?? null,
    selected_ids: receipt.selected_ids,
    selected_count: receipt.selected_count,
    provisioned_runtimes: receipt.provisioned_runtimes,
    // One measured provision for the whole selected invocation is the
    // one-runtime fact; the per-ID results remain owned by the trusted
    // Run Record, not by this receipt.
    one_runtime_for_selected_run: receipt.provisioned_runtimes === 1,
    evidence: 'GitHub API Run/Attempt/job/step outcomes + exact original ' +
      'selected E2E job log receipt emitted by the measured run',
  });
}

// Only one receipt line may exist. Duplicated or ambiguous framing is rejected
// rather than guessed.
export function parseE2eSelectedRunLog(log) {
  if (typeof log !== 'string' || log.length > 4194304) {
    throw Error('invalid selected E2E run log size');
  }
  const candidates = log.split(/\r?\n/)
    .filter((line) => line.includes(E2E_SELECTED_RUN_LOG_PREFIX));
  if (candidates.length !== 1) return null;
  const match = candidates[0].match(/E2E_SELECTED_RUN_RECEIPT_V1 (\{.*\})\s*$/);
  if (!match || match[1].length > 16384) {
    throw Error('invalid selected E2E run record framing');
  }
  return validateE2eSelectedRunReceipt(JSON.parse(match[1]));
}

// ── Explicit `not-required` skip receipt ─────────────────────────────────
// A counted outcome is a claim; GitHub's own `steps.<id>.outcome` is the
// measurement. The receipt carries those resolved outcomes, and attestation
// re-reads the same step conclusions from the job API instead of trusting it.
export const E2E_NOT_REQUIRED_LOG_PREFIX = 'E2E_NOT_REQUIRED_RECEIPT_V1 ';
export const E2E_NOT_REQUIRED_KIND = 'e2e_not_required';
const OUTCOME = (x) => ['skipped', 'success', 'failure', 'cancelled'].includes(x);
export const E2E_NOT_REQUIRED_STEPS = Object.freeze([
  Object.freeze(['rust_toolchain', 'Install Rust toolchain', 'skipped']),
  Object.freeze(['cargo_build', 'Build Rust binaries', 'skipped']),
  Object.freeze(['tmux', 'Install tmux', 'skipped']),
  Object.freeze(['design_gate', 'Run canonical browser design gate', 'success']),
]);

export function makeE2eNotRequiredReceipt({ env, runId, runAttempt, sha, steps }) {
  const run = positiveInt(runId ?? env?.GITHUB_RUN_ID);
  const attempt = positiveInt(runAttempt ?? env?.GITHUB_RUN_ATTEMPT);
  if (env?.GITHUB_REPOSITORY !== REPO || run === null || attempt === null ||
      !SHA.test(String(sha ?? '')) || !steps ||
      !E2E_NOT_REQUIRED_STEPS.every(([key]) => OUTCOME(steps[key])) ||
      !E2E_NOT_REQUIRED_STEPS.every(([key, , expected]) => steps[key] === expected)) {
    return null;
  }
  return Object.freeze({
    schema_version: 1,
    kind: E2E_NOT_REQUIRED_KIND,
    repository: REPO,
    workflow: E2E_SELECTED_WORKFLOW,
    run_id: run,
    run_attempt: attempt,
    sha,
    plan_mode: 'not-required',
    steps: Object.freeze(Object.fromEntries(
      E2E_NOT_REQUIRED_STEPS.map(([key]) => [key, steps[key]]),
    )),
  });
}

export function validateE2eNotRequiredReceipt(receipt) {
  if (receipt?.schema_version !== 1 || receipt.kind !== E2E_NOT_REQUIRED_KIND ||
      receipt.repository !== REPO || receipt.workflow !== E2E_SELECTED_WORKFLOW ||
      !POS(receipt.run_id) || !POS(receipt.run_attempt) ||
      !SHA.test(receipt.sha ?? '') || receipt.plan_mode !== 'not-required' ||
      !receipt.steps || typeof receipt.steps !== 'object' ||
      !E2E_NOT_REQUIRED_STEPS.every(([key, , expected]) => receipt.steps[key] === expected)) {
    throw Error('invalid not-required E2E receipt');
  }
  const allowed = new Set(['schema_version', 'kind', 'repository', 'workflow',
    'run_id', 'run_attempt', 'sha', 'plan_mode', 'steps']);
  if (Object.keys(receipt).some((key) => !allowed.has(key))) {
    throw Error('unexpected not-required E2E receipt fields');
  }
  const stepKeys = new Set(E2E_NOT_REQUIRED_STEPS.map(([key]) => key));
  if (Object.keys(receipt.steps).some((key) => !stepKeys.has(key))) {
    throw Error('unexpected not-required E2E receipt step fields');
  }
  return receipt;
}

export function attestE2eNotRequiredReceipt(receipt, run, job) {
  validateE2eNotRequiredReceipt(receipt);
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  for (const [key, name, expected] of E2E_NOT_REQUIRED_STEPS) {
    const matches = steps.filter((step) => step?.name === name);
    // The job API must agree with the receipt's claimed outcome, and the
    // required design gate must actually have run and passed.
    if (matches.length !== 1 || matches[0].conclusion !== expected ||
        receipt.steps[key] !== expected) {
      throw Error('not-required E2E receipt step provenance mismatch: ' + name);
    }
  }
  if (run?.id !== receipt.run_id ||
      run?.run_attempt !== receipt.run_attempt ||
      run?.head_sha !== receipt.sha ||
      !E2E_SELECTED_EVENTS.includes(run?.event) ||
      run?.name !== E2E_SELECTED_WORKFLOW_NAME ||
      normalizeWorkflowPath(run?.path) !== E2E_SELECTED_WORKFLOW ||
      run?.repository?.full_name !== REPO ||
      run?.head_repository?.full_name !== REPO ||
      run?.status !== 'completed' || run?.conclusion !== 'success' ||
      job?.name !== E2E_SELECTED_JOB ||
      job?.run_id !== receipt.run_id ||
      job?.run_attempt !== receipt.run_attempt ||
      job?.head_sha !== receipt.sha ||
      job?.status !== 'completed' || job?.conclusion !== 'success') {
    throw Error('not-required E2E receipt Run/Attempt/job provenance mismatch');
  }
  return Object.freeze({
    kind: 'verified_e2e_not_required',
    run_id: receipt.run_id,
    run_attempt: receipt.run_attempt,
    sha: receipt.sha,
    event: run.event,
    branch: run.head_branch ?? null,
    plan_mode: 'not-required',
    skipped_e2e_only_steps: E2E_NOT_REQUIRED_STEPS
      .filter(([, , expected]) => expected === 'skipped').map(([key]) => key),
    design_gate: 'success',
    evidence: 'GitHub API Run/Attempt/job step outcomes + exact original ' +
      'not-required E2E job log receipt emitted by the measured run',
  });
}

export function parseE2eNotRequiredLog(log) {
  if (typeof log !== 'string' || log.length > 4194304) {
    throw Error('invalid not-required E2E run log size');
  }
  const candidates = log.split(/\r?\n/)
    .filter((line) => line.includes(E2E_NOT_REQUIRED_LOG_PREFIX));
  if (candidates.length !== 1) return null;
  const match = candidates[0].match(/E2E_NOT_REQUIRED_RECEIPT_V1 (\{.*\})\s*$/);
  if (!match || match[1].length > 16384) {
    throw Error('invalid not-required E2E record framing');
  }
  return validateE2eNotRequiredReceipt(JSON.parse(match[1]));
}

function emitNotRequired() {
  const receipt = makeE2eNotRequiredReceipt({
    env: process.env,
    sha: arg('sha', true),
    steps: {
      rust_toolchain: arg('rust', true),
      cargo_build: arg('cargo', true),
      tmux: arg('tmux', true),
      design_gate: arg('design', true),
    },
  });
  if (!receipt) throw new Error('not-required E2E receipt inputs are invalid');
  process.stdout.write(E2E_NOT_REQUIRED_LOG_PREFIX + JSON.stringify(receipt) + '\n');
}

function arg(name, required = false) {
  const index = process.argv.indexOf('--' + name);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (required && (!value || value.startsWith('--'))) {
    throw new Error('--' + name + ' is required');
  }
  return value;
}

function emit() {
  const receipt = makeE2eSelectedRunReceipt({
    env: process.env,
    sha: arg('sha', true),
    selectedIds: String(arg('ids', true)).split(',').map((id) => id.trim()).filter(Boolean),
    provisions: Number(arg('provisions', true)),
  });
  if (!receipt) throw new Error('selected E2E run receipt inputs are invalid');
  process.stdout.write(E2E_SELECTED_RUN_LOG_PREFIX + JSON.stringify(receipt) + '\n');
}

function selfTest() {
  const sha = 'a'.repeat(40);
  const env = { GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '1' };
  const receipt = makeE2eSelectedRunReceipt({
    env, sha, selectedIds: ['terminal-io', 'login', 'session-lifecycle'], provisions: 1,
  });
  assert.equal(validateE2eSelectedRunReceipt(receipt).selected_count, 3);
  assert.deepEqual(receipt.selected_ids, ['login', 'session-lifecycle', 'terminal-io']);
  const run = {
    id: 12, run_attempt: 1, head_sha: sha, head_branch: 'feat/x', event: 'pull_request',
    name: E2E_SELECTED_WORKFLOW_NAME, path: E2E_SELECTED_WORKFLOW,
    repository: { full_name: REPO }, head_repository: { full_name: REPO },
    status: 'completed', conclusion: 'success',
  };
  const job = {
    name: E2E_SELECTED_JOB, run_id: 12, run_attempt: 1, head_sha: sha,
    status: 'completed', conclusion: 'success',
    steps: [{ name: E2E_SELECTED_STEP, conclusion: 'success' }],
  };
  const attested = attestE2eSelectedRunReceipt(receipt, run, job);
  assert.equal(attested.one_runtime_for_selected_run, true);
  assert.equal(attestE2eSelectedRunReceipt(receipt,
    { ...run, path: E2E_SELECTED_WORKFLOW + '@refs/pull/1/merge' }, job).sha, sha);
  // Two provisions is a real measurement, not an error: it simply does not
  // establish one runtime, and the receipt says so instead of hiding it.
  const two = makeE2eSelectedRunReceipt({ env, sha, selectedIds: ['login'], provisions: 2 });
  assert.equal(attestE2eSelectedRunReceipt(two, run, job).one_runtime_for_selected_run, false);

  // Invalid inputs never produce a receipt.
  assert.equal(makeE2eSelectedRunReceipt({ env, sha: 'short', selectedIds: ['login'], provisions: 1 }), null);
  assert.equal(makeE2eSelectedRunReceipt({ env, sha, selectedIds: [], provisions: 1 }), null);
  assert.equal(makeE2eSelectedRunReceipt({ env, sha, selectedIds: ['Bad ID'], provisions: 1 }), null);
  assert.equal(makeE2eSelectedRunReceipt({ env, sha, selectedIds: ['login', 'login'], provisions: 1 }), null);
  assert.equal(makeE2eSelectedRunReceipt({ env, sha, selectedIds: ['login'], provisions: 0 }), null);
  assert.equal(makeE2eSelectedRunReceipt({ env, sha, selectedIds: ['login'], provisions: 1.5 }), null);
  assert.equal(makeE2eSelectedRunReceipt({ env: { ...env, GITHUB_REPOSITORY: 'x/y' },
    sha, selectedIds: ['login'], provisions: 1 }), null);
  assert.equal(makeE2eSelectedRunReceipt({ env: { ...env, GITHUB_RUN_ID: 'x' },
    sha, selectedIds: ['login'], provisions: 1 }), null);

  const reject = (fn, pattern) => assert.throws(fn, pattern);
  const bound = receipt;
  reject(() => attestE2eSelectedRunReceipt(bound, { ...run, head_sha: 'b'.repeat(40) }, job), /mismatch/);
  reject(() => attestE2eSelectedRunReceipt(bound, { ...run, event: 'push' }, job), /mismatch/);
  reject(() => attestE2eSelectedRunReceipt(bound, { ...run, name: 'CI / Quality Gate',
    path: '.github/workflows/ci-quality.yml' }, job), /mismatch/);
  reject(() => attestE2eSelectedRunReceipt(bound, run, { ...job, conclusion: 'failure' }), /mismatch/);
  reject(() => attestE2eSelectedRunReceipt(bound, run,
    { ...job, steps: [{ name: E2E_SELECTED_STEP, conclusion: 'failure' }] }), /mismatch/);
  reject(() => attestE2eSelectedRunReceipt(bound, run, { ...job, steps: [] }), /mismatch/);
  reject(() => attestE2eSelectedRunReceipt(bound, run, { ...job, name: 'publish' }), /mismatch/);
  reject(() => validateE2eSelectedRunReceipt({ ...receipt, protected: true }), /unexpected/);
  reject(() => validateE2eSelectedRunReceipt({ ...receipt, selected_count: 2 }), /invalid/);

  const line = 'step output\n' + E2E_SELECTED_RUN_LOG_PREFIX + JSON.stringify(bound) + '\n';
  assert.equal(parseE2eSelectedRunLog(line).selected_count, 3);
  assert.equal(parseE2eSelectedRunLog('none'), null);
  assert.equal(parseE2eSelectedRunLog(line + E2E_SELECTED_RUN_LOG_PREFIX +
    JSON.stringify(bound) + '\n'), null);
  reject(() => parseE2eSelectedRunLog(E2E_SELECTED_RUN_LOG_PREFIX + '{"not":'), /framing/);

  // ── Explicit `not-required` skip: only real measured skips are accepted.
  const nrSteps = {
    rust_toolchain: 'skipped', cargo_build: 'skipped', tmux: 'skipped',
    design_gate: 'success',
  };
  const nr = makeE2eNotRequiredReceipt({ env, sha, steps: nrSteps });
  assert.equal(validateE2eNotRequiredReceipt(nr).plan_mode, 'not-required');
  const nrJob = {
    name: E2E_SELECTED_JOB, run_id: 12, run_attempt: 1, head_sha: sha,
    status: 'completed', conclusion: 'success',
    steps: E2E_NOT_REQUIRED_STEPS.map(([, name, conclusion]) => ({ name, conclusion })),
  };
  const nrAttested = attestE2eNotRequiredReceipt(nr, run, nrJob);
  assert.deepEqual(nrAttested.skipped_e2e_only_steps,
    ['rust_toolchain', 'cargo_build', 'tmux']);
  assert.equal(nrAttested.design_gate, 'success');
  // The design gate must have RUN: a skipped design gate is not a Pass.
  assert.equal(makeE2eNotRequiredReceipt({ env, sha,
    steps: { ...nrSteps, design_gate: 'skipped' } }), null);
  // A Rust build that ran is not a skip.
  assert.equal(makeE2eNotRequiredReceipt({ env, sha,
    steps: { ...nrSteps, cargo_build: 'success' } }), null);
  assert.equal(makeE2eNotRequiredReceipt({ env: { ...env, GITHUB_REPOSITORY: 'x/y' },
    sha, steps: nrSteps }), null);
  // The job API must agree with the claimed outcomes.
  reject(() => attestE2eNotRequiredReceipt(nr, run, { ...nrJob,
    steps: E2E_NOT_REQUIRED_STEPS.map(([, name]) =>
      ({ name, conclusion: name === 'Build Rust binaries' ? 'success' : 'skipped' })) }),
  /provenance mismatch/);
  reject(() => attestE2eNotRequiredReceipt(nr, { ...run, event: 'push' }, nrJob), /mismatch/);
  reject(() => attestE2eNotRequiredReceipt(nr, run, { ...nrJob, conclusion: 'failure' }), /mismatch/);
  reject(() => attestE2eNotRequiredReceipt(nr, { ...run, head_sha: 'b'.repeat(40) }, nrJob), /mismatch/);
  const nrLine = 'step output\n' + E2E_NOT_REQUIRED_LOG_PREFIX + JSON.stringify(nr) + '\n';
  assert.equal(parseE2eNotRequiredLog(nrLine).plan_mode, 'not-required');
  assert.equal(parseE2eNotRequiredLog(line), null);
  reject(() => parseE2eNotRequiredLog(E2E_NOT_REQUIRED_LOG_PREFIX + '{"not":'), /framing/);
  console.log('e2e-selected-run-receipt self-test passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  if (command === 'emit' || command === 'emit-not-required') {
    try {
      if (command === 'emit') emit();
      else emitNotRequired();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else {
    selfTest();
  }
}
