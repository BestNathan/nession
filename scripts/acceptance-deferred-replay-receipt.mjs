#!/usr/bin/env node
// Deferred pre-merge Acceptance replay receipt (#2461 SC-02).
//
// A deferred PR Acceptance run proves the fix only when a later evaluator can
// see three facts together: the run was cancelled by the trusted deferral
// (not by a failure), the main-owned waker replayed it, and the replayed
// attempt reached `pre-merge-acceptance`.
//
// The replayed run lives on the PR HEAD while a post-merge evaluator's target
// is a merged main SHA, so the target-SHA run window cannot reach it — and
// `retainedRuns` keeps one run per workflow path, which can drop the waker's
// own workflow_run Run behind a newer orchestrator Run at the same SHA. The
// waker therefore writes this bounded receipt into its own job log, the same
// channel as the Metrics replay denial, Run Store policy and Acceptance batch
// receipts.
//
// The producer runs on trusted main, but a job log is still text: every field
// is re-authenticated against REST identities, and both attempts' canonical
// jobs are re-read before the receipt can become evidence. The receipt never
// grants a verdict by itself.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export const DEFERRED_REPLAY_LOG_PREFIX = 'ACCEPTANCE_DEFERRED_REPLAY_V1 ';
export const DEFERRED_REPLAY_WORKFLOW = '.github/workflows/acceptance-orchestrator.yml';
export const DEFERRED_REPLAY_WORKFLOW_NAME = 'Acceptance / Orchestrator';
// Two trusted main-owned jobs replay a deferred run: the workflow_run waker
// and the E2E-projection reconcile (repository_dispatch). Whichever wins the
// race writes the receipt, so both are admissible evidence producers.
export const DEFERRED_REPLAY_JOBS = Object.freeze([
  'reconcile-completed-quality-e2e',
  'reconcile-issue-e2e',
]);
export const DEFERRED_REPLAY_EVENTS = Object.freeze([
  'workflow_run',
  'repository_dispatch',
]);
// The waker paths, kept as named constants for the workflow-shape self-test.
export const DEFERRED_REPLAY_JOB = DEFERRED_REPLAY_JOBS[0];
export const DEFERRED_REPLAY_EVENT = DEFERRED_REPLAY_EVENTS[0];
export const DEFERRED_REPLAY_BRANCH = 'main';
export const DEFERRED_REPLAY_SOURCE_EVENT = 'pull_request_target';
export const DEFERRED_REPLAY_RESULT = 'replayed';
export const DEFERRED_REPLAY_RESULTS = Object.freeze(['replayed', 'changed_before_replay']);
export const DEFERRED_ADMISSION_STEP = 'Classify exact-head source barrier';
export const REPO = 'BestNathan/nession';
const SHA = /^[a-f0-9]{40}$/;
const POS = (x) => Number.isSafeInteger(x) && x > 0;
const MAX_LOG_BYTES = 2097152;
const MAX_RECORD_BYTES = 65536;
// The waker may replay only an attempt the trusted classifier deferred;
// `isDeferredRun` refuses attempt 3 and later, so a deferred attempt is 1 or 2.
const MAX_DEFERRED_ATTEMPT = 2;

function positiveInt(x) {
  const parsed = Number(x);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeWorkflowPath(value) {
  return String(value ?? '').replace(/@refs\/[^\s]+$/, '');
}

export function makeDeferredReplayReceipt({
  env, sourceRunId, targetSha, pr, replayedRunId, deferredAttempt,
  result = DEFERRED_REPLAY_RESULT,
}) {
  const source = positiveInt(sourceRunId ?? env?.GITHUB_RUN_ID);
  const sourceAttempt = positiveInt(env?.GITHUB_RUN_ATTEMPT);
  const run = positiveInt(replayedRunId);
  const attempt = positiveInt(deferredAttempt);
  const pull = positiveInt(pr);
  if (env?.GITHUB_REPOSITORY !== REPO || source === null || sourceAttempt === null ||
      run === null || attempt === null || attempt > MAX_DEFERRED_ATTEMPT ||
      pull === null || !SHA.test(String(targetSha ?? '')) ||
      !DEFERRED_REPLAY_RESULTS.includes(result)) {
    return null;
  }
  return Object.freeze({
    schema_version: 1,
    kind: 'deferred_acceptance_replay',
    repository: REPO,
    source_run_id: source,
    source_run_attempt: sourceAttempt,
    target_sha: targetSha,
    pr: pull,
    replayed_run_id: run,
    deferred_attempt: attempt,
    result,
  });
}

export function validateDeferredReplayReceipt(receipt) {
  if (receipt === null || typeof receipt !== 'object' ||
      receipt.schema_version !== 1 ||
      receipt.kind !== 'deferred_acceptance_replay' ||
      receipt.repository !== REPO ||
      !POS(receipt.source_run_id) || !POS(receipt.source_run_attempt) ||
      !SHA.test(String(receipt.target_sha ?? '')) ||
      !POS(receipt.pr) || !POS(receipt.replayed_run_id) ||
      !POS(receipt.deferred_attempt) ||
      receipt.deferred_attempt > MAX_DEFERRED_ATTEMPT ||
      !DEFERRED_REPLAY_RESULTS.includes(receipt.result)) {
    throw Error('invalid deferred Acceptance replay receipt');
  }
  return receipt;
}

// A job log contains two kinds of line mentioning the prefix: the workflow's
// own **source text** (`printf '%s\n' "ACCEPTANCE_DEFERRED_REPLAY_V1 …"`), and
// the record the step actually writes. Only a line whose tail is a JSON object
// is a record; source text is skipped. A framed record that does not validate
// is a producer defect and throws, as the batch receipt does.
export function parseDeferredReplayLog(log) {
  if (typeof log !== 'string' || log.length > MAX_LOG_BYTES) {
    throw Error('invalid deferred Acceptance replay log size');
  }
  const receipts = [];
  for (const line of log.split(/\r?\n/)) {
    if (!line.includes(DEFERRED_REPLAY_LOG_PREFIX)) continue;
    const match = line.match(/ACCEPTANCE_DEFERRED_REPLAY_V1 (\{.*\})\s*$/);
    // Not a record: the workflow source text names the prefix too.
    if (!match) continue;
    if (match[1].length > MAX_RECORD_BYTES) {
      throw Error('invalid deferred Acceptance replay record framing');
    }
    let record;
    try {
      record = JSON.parse(match[1]);
    } catch {
      throw Error('invalid deferred Acceptance replay record framing');
    }
    receipts.push(validateDeferredReplayReceipt(record));
  }
  return receipts;
}

// Re-bind the receipt to the waker Run/Attempt/Job and to BOTH attempts of the
// replayed run. `targetSha` is the merged main HEAD the evaluator is judging;
// the replayed run must be a different, PR-head target.
export function attestDeferredReplayReceipt({
  receipt, wakerRun, wakerJob, deferredRun, deferredJobs, replayJobs, targetSha,
}) {
  validateDeferredReplayReceipt(receipt);
  if (!SHA.test(String(targetSha ?? '')) ||
      wakerRun?.id !== receipt.source_run_id ||
      wakerRun?.run_attempt !== receipt.source_run_attempt ||
      wakerRun?.head_sha !== targetSha ||
      wakerRun?.head_branch !== DEFERRED_REPLAY_BRANCH ||
      !DEFERRED_REPLAY_EVENTS.includes(wakerRun?.event) ||
      normalizeWorkflowPath(wakerRun?.path) !== DEFERRED_REPLAY_WORKFLOW ||
      wakerRun?.name !== DEFERRED_REPLAY_WORKFLOW_NAME ||
      wakerRun?.status !== 'completed' || wakerRun?.conclusion !== 'success') {
    throw Error('deferred replay waker identity mismatch');
  }
  if (!DEFERRED_REPLAY_JOBS.includes(wakerJob?.name) ||
      wakerJob?.conclusion !== 'success' ||
      wakerJob?.run_id !== wakerRun.id ||
      wakerJob?.run_attempt !== wakerRun.run_attempt) {
    throw Error('deferred replay waker job mismatch');
  }
  if (receipt.target_sha === targetSha) {
    throw Error('deferred replay target must be a PR head, not the merged target');
  }
  if (deferredRun?.id !== receipt.replayed_run_id ||
      deferredRun?.event !== DEFERRED_REPLAY_SOURCE_EVENT ||
      normalizeWorkflowPath(deferredRun?.path) !== DEFERRED_REPLAY_WORKFLOW ||
      deferredRun?.head_sha !== receipt.target_sha ||
      deferredRun?.status !== 'completed' ||
      deferredRun?.run_attempt !== receipt.deferred_attempt + 1) {
    throw Error('deferred replay target identity mismatch');
  }
  if (!Array.isArray(deferredJobs) || !Array.isArray(replayJobs)) {
    throw Error('invalid deferred replay attempt jobs');
  }
  const prepare = deferredJobs.find((job) => job?.name === 'prepare-pre-merge');
  const defer = deferredJobs.find((job) => job?.name === 'defer-pre-merge');
  const admission = (prepare?.steps ?? [])
    .find((step) => step?.name === DEFERRED_ADMISSION_STEP);
  // A deferral job may conclude `success` when it exits after GitHub accepted
  // the cancel request (the run then becomes cancelled), or `cancelled` when
  // the cancellation terminated it first. Both are the same trusted decision;
  // skipped/failure/absent defer jobs are not.
  if (prepare?.conclusion !== 'success' ||
      !['cancelled', 'success'].includes(defer?.conclusion) ||
      admission?.conclusion !== 'success') {
    throw Error('deferred attempt is not a trusted deferral');
  }
  const replayDefer = replayJobs.find((job) => job?.name === 'defer-pre-merge');
  if (replayDefer && replayDefer.conclusion !== 'skipped') {
    throw Error('replayed attempt re-deferred instead of evaluating');
  }
  const acceptance = replayJobs.filter((job) =>
    /^pre-merge-acceptance(?: \(|$)/.test(String(job?.name ?? '')));
  if (acceptance.length === 0 ||
      acceptance.some((job) => job.conclusion === 'failure' ||
        job.conclusion === 'cancelled') ||
      !acceptance.some((job) => job.conclusion === 'success')) {
    throw Error('replayed attempt did not reach a successful pre-merge-acceptance');
  }
  return Object.freeze({
    kind: 'verified_deferred_acceptance_replay',
    repository: REPO,
    target_sha: targetSha,
    pr: receipt.pr,
    waker_run_id: wakerRun.id,
    waker_run_attempt: wakerRun.run_attempt,
    deferred_run_id: deferredRun.id,
    deferred_attempt: receipt.deferred_attempt,
    replay_attempt: deferredRun.run_attempt,
    deferred_pr_head: receipt.target_sha,
    deferral: Object.freeze({
      prepare_pre_merge: 'success',
      admission_evaluated: 'success',
      defer_pre_merge: defer.conclusion,
    }),
    replay: Object.freeze({
      defer_pre_merge: replayDefer ? 'skipped' : 'absent',
      pre_merge_acceptance: 'success',
      pre_merge_acceptance_jobs: Object.freeze(
        acceptance.map((job) => String(job.name))),
    }),
  });
}

function selfTest() {
  const mainSha = 'a'.repeat(40);
  const prHead = 'b'.repeat(40);
  const env = {
    GITHUB_REPOSITORY: REPO,
    GITHUB_RUN_ID: '40264172173',
    GITHUB_RUN_ATTEMPT: '1',
  };
  const receipt = makeDeferredReplayReceipt({
    env, sourceRunId: 40264172173, targetSha: prHead, pr: 2465,
    replayedRunId: 40263312546, deferredAttempt: 1,
  });
  assert.ok(receipt, 'a well-formed replay receipt is accepted');

  assert.equal(makeDeferredReplayReceipt({
    env: { ...env, GITHUB_REPOSITORY: 'evil/nession' },
    sourceRunId: 40264172173, targetSha: prHead, pr: 2465,
    replayedRunId: 40263312546, deferredAttempt: 1,
  }), null, 'a foreign repository cannot mint a receipt');
  assert.equal(makeDeferredReplayReceipt({
    env, sourceRunId: 40264172173, targetSha: prHead, pr: 2465,
    replayedRunId: 40263312546, deferredAttempt: 3,
  }), null, 'an attempt the classifier could not have deferred is rejected');

  const log = '2026-10-26T03:27:39Z ' + DEFERRED_REPLAY_LOG_PREFIX +
    JSON.stringify(receipt) + '\n';
  // The workflow source text names the prefix; it is not a receipt and must
  // not make the whole log unparseable (it did, until this fix).
  const scriptText = '    printf \'%s\\n\' "ACCEPTANCE_DEFERRED_REPLAY_V1 ' +
    '${replay_receipt}"\n';
  assert.deepEqual(parseDeferredReplayLog(scriptText), []);
  const parsed = parseDeferredReplayLog(scriptText + log);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].replayed_run_id, 40263312546);
  assert.throws(() => parseDeferredReplayLog(
    DEFERRED_REPLAY_LOG_PREFIX + '{not json}\n'), /record framing/);
  assert.throws(() => parseDeferredReplayLog(
    DEFERRED_REPLAY_LOG_PREFIX + JSON.stringify({ ...receipt, result: 'other' }) + '\n'),
    /invalid deferred Acceptance replay receipt/);

  // The CLI producer and the parser are one contract: what emit prints must
  // parse back, and invalid inputs must fail the step instead of printing.
  const emitted = emitDeferredReplayReceipt({
    GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '40264172173',
    GITHUB_RUN_ATTEMPT: '1', TARGET_SHA: prHead, PR_NUMBER: '2465',
    REPLAYED_RUN_ID: '40263312546', DEFERRED_ATTEMPT: '1',
    REPLAY_RESULT: 'replayed',
  });
  assert.equal(parseDeferredReplayLog(emitted)[0].replayed_run_id, 40263312546);
  assert.throws(() => emitDeferredReplayReceipt({
    GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '40264172173',
    GITHUB_RUN_ATTEMPT: '1', TARGET_SHA: 'not-a-sha', PR_NUMBER: '2465',
    REPLAYED_RUN_ID: '40263312546', DEFERRED_ATTEMPT: '1',
  }), /invalid deferred Acceptance replay receipt inputs/);

  const wakerRun = {
    id: 40264172173, run_attempt: 1, head_sha: mainSha, head_branch: 'main',
    event: 'workflow_run', status: 'completed', conclusion: 'success',
    name: DEFERRED_REPLAY_WORKFLOW_NAME,
    path: DEFERRED_REPLAY_WORKFLOW + '@refs/heads/main',
  };
  const wakerJob = {
    id: 121382795145, name: DEFERRED_REPLAY_JOB, conclusion: 'success',
    run_id: wakerRun.id, run_attempt: 1,
  };
  const deferredRun = {
    id: 40263312546, event: 'pull_request_target', head_sha: prHead,
    head_branch: 'fix/2464-bootstrap-buffer-cursor', status: 'completed',
    conclusion: 'success', run_attempt: 2,
    path: DEFERRED_REPLAY_WORKFLOW,
  };
  const deferredJobs = [
    { name: 'prepare-pre-merge', conclusion: 'success', steps: [
      { name: DEFERRED_ADMISSION_STEP, conclusion: 'success' }] },
    // The deferral job exits successfully after the accepted cancel request;
    // the run itself becomes cancelled. Older deferrals were terminated with
    // conclusion `cancelled` and stay valid.
    { name: 'defer-pre-merge', conclusion: 'success' },
  ];
  const replayJobs = [
    { name: 'prepare-pre-merge', conclusion: 'success' },
    { name: 'defer-pre-merge', conclusion: 'skipped' },
    { name: 'pre-merge-acceptance (2464) / Resolve selected Acceptor on trusted main',
      conclusion: 'success' },
    { name: 'pre-merge-acceptance (2464) / Execute acceptance', conclusion: 'success' },
    { name: 'pre-merge-acceptance (2464) / Deterministic Issue updater',
      conclusion: 'success' },
  ];
  const proof = attestDeferredReplayReceipt({
    receipt, wakerRun, wakerJob, deferredRun, deferredJobs, replayJobs,
    targetSha: mainSha,
  });
  assert.equal(proof.kind, 'verified_deferred_acceptance_replay');
  assert.equal(proof.pr, 2465);
  assert.equal(proof.deferred_attempt, 1);
  assert.equal(proof.replay_attempt, 2);
  assert.equal(proof.deferral.defer_pre_merge, 'success');
  assert.equal(proof.replay.pre_merge_acceptance, 'success');
  // Backward-compatible: a deferral job terminated by the run cancellation
  // (the pre-#2323 shape) remains a trusted deferral.
  const cancelledDeferProof = attestDeferredReplayReceipt({
    receipt, wakerRun, wakerJob,
    deferredRun,
    deferredJobs: deferredJobs.map((job) => job.name === 'defer-pre-merge'
      ? { ...job, conclusion: 'cancelled' } : job),
    replayJobs, targetSha: mainSha,
  });
  assert.equal(cancelledDeferProof.deferral.defer_pre_merge, 'cancelled');

  // The E2E-projection reconcile is the other trusted replay producer; a
  // replay it performs is the same behavioral fact.
  const projectionProof = attestDeferredReplayReceipt({
    receipt, wakerRun: { ...wakerRun, event: 'repository_dispatch' },
    wakerJob: { ...wakerJob, name: 'reconcile-issue-e2e' },
    deferredRun, deferredJobs, replayJobs, targetSha: mainSha,
  });
  assert.equal(projectionProof.replay_attempt, 2);
  assert.throws(() => attestDeferredReplayReceipt({
    receipt, wakerRun: { ...wakerRun, event: 'push' }, wakerJob,
    deferredRun, deferredJobs, replayJobs, targetSha: mainSha,
  }), /waker identity mismatch/, 'an untrusted event cannot produce evidence');
  assert.throws(() => attestDeferredReplayReceipt({
    receipt, wakerRun, wakerJob: { ...wakerJob, name: 'untrusted-job' },
    deferredRun, deferredJobs, replayJobs, targetSha: mainSha,
  }), /waker job mismatch/, 'an untrusted job cannot produce evidence');

  const attests = (overrides) => () => attestDeferredReplayReceipt({
    receipt, wakerRun, wakerJob, deferredRun, deferredJobs, replayJobs,
    targetSha: mainSha, ...overrides,
  });
  assert.throws(attests({ wakerRun: { ...wakerRun, head_sha: prHead } }),
    /waker identity mismatch/, 'the waker must run at the merged target');
  assert.throws(attests({ wakerJob: { ...wakerJob, conclusion: 'failure' } }),
    /waker job mismatch/);
  assert.throws(attests({ deferredRun: { ...deferredRun, run_attempt: 3 } }),
    /target identity mismatch/, 'exactly one replay is admissible');
  assert.throws(attests({ deferredRun: { ...deferredRun, head_sha: mainSha } }),
    /target identity mismatch/);
  assert.throws(attests({ deferredJobs: [
    { name: 'prepare-pre-merge', conclusion: 'success', steps: [
      { name: DEFERRED_ADMISSION_STEP, conclusion: 'success' }] },
    { name: 'defer-pre-merge', conclusion: 'skipped' },
  ] }), /not a trusted deferral/, 'a run that evaluated was not deferred');
  assert.throws(attests({ replayJobs: replayJobs.map((job) =>
    job.name === 'defer-pre-merge' ? { ...job, conclusion: 'cancelled' } : job) }),
  /re-deferred/);
  assert.throws(attests({ replayJobs: replayJobs.map((job) =>
    job.name === 'pre-merge-acceptance (2464) / Execute acceptance'
      ? { ...job, conclusion: 'failure' } : job) }),
  /did not reach/);
  console.log('Deferred Acceptance replay receipt: producer/parser/attestation and fail-closed negatives passed');
}

// The workflow's replay paths call this instead of hand-building the JSON, so
// the producer and the parser share one owner. Inputs come from the step
// environment; an invalid input fails the step rather than printing nothing.
export function emitDeferredReplayReceipt(env = process.env) {
  const receipt = makeDeferredReplayReceipt({
    env,
    sourceRunId: env.GITHUB_RUN_ID,
    targetSha: env.TARGET_SHA,
    pr: env.PR_NUMBER,
    replayedRunId: env.REPLAYED_RUN_ID,
    deferredAttempt: env.DEFERRED_ATTEMPT,
    result: env.REPLAY_RESULT || DEFERRED_REPLAY_RESULT,
  });
  if (!receipt) throw Error('invalid deferred Acceptance replay receipt inputs');
  return DEFERRED_REPLAY_LOG_PREFIX + JSON.stringify(receipt);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv[2] === 'emit') {
    try {
      console.log(emitDeferredReplayReceipt(process.env));
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 2;
    }
  } else {
    selfTest();
  }
}

export { selfTest as selfTestDeferredReplayReceipt };
