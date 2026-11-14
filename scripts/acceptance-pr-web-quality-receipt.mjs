#!/usr/bin/env node
// Trusted-main PR Acceptance proof boundary for executable Web integration SCs.
// Model prose/test source is never evidence that a GitHub Quality Gate executed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const REPO = 'BestNathan/nession';
const WORKFLOW = '.github/workflows/ci-quality.yml';
const SHA = /^[a-f0-9]{40}$/i;
const GATE_STEP = 'Verify Web and design Gates';
const CHECK_STEP = 'Enforce applicable Quality results at the stable check name';

// A criterion must demand an actual integration-test assertion, not merely
// discuss a Gate/SC policy or mention a test file in supporting prose.
// The Issue's Web scenario narrows this to the Web Quality owner, not Rust or
// independent Browser/Case execution. This classifier has exactly one owner.
export function requiresWebIntegrationExecution(criterion, issueBody = '') {
  const text = String(criterion?.text ?? '');
  if (!/\bweb\b|\bchromium\b|\.tsx\b|web-test-integration/i.test(String(issueBody))) return false;
  return /\bintegration[ -]+tests?\s+(?:records?|checks?|verifies?|asserts?|runs?|executes?|passes?|covers?|fails?)\b|\b(?:run|execute|pass|verify)\s+(?:the\s+)?(?:deterministic\s+)?(?:web\s+)?integration[ -]+tests?\b/i.test(text);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function validWebQualityReceipt(receipt, sha) {
  return Boolean(receipt && SHA.test(String(sha)) &&
    receipt.kind === 'pr_web_quality_execution_v1' &&
    receipt.repository === REPO && receipt.workflow === WORKFLOW &&
    receipt.head_sha === sha &&
    positiveInteger(receipt.run_id) && positiveInteger(receipt.run_attempt) &&
    positiveInteger(receipt.web_tests_job_id) &&
    positiveInteger(receipt.web_check_job_id) &&
    receipt.web_gate_step === GATE_STEP &&
    receipt.web_check_step === CHECK_STEP);
}

function successfulJob(jobs, name, step, run, attempt) {
  const matches = jobs.filter(job => job?.name === name);
  if (matches.length !== 1) return { reason: name + ' job is missing or ambiguous' };
  const job = matches[0];
  if (job.run_id !== run.id ||
      (job.run_attempt != null && job.run_attempt !== attempt)) {
    return { reason: name + ' job has wrong run/attempt identity' };
  }
  if (job.status !== 'completed' || job.conclusion !== 'success') {
    return { reason: name + ' job is ' + String(job.status ?? 'missing') +
      '/' + String(job.conclusion ?? 'pending') };
  }
  if (!positiveInteger(job.id) || !Array.isArray(job.steps)) {
    return { reason: name + ' job has no verifiable steps' };
  }
  const steps = job.steps.filter(item => item.name === step);
  if (steps.length !== 1 || steps[0].status !== 'completed' ||
      steps[0].conclusion !== 'success') {
    return { reason: name + ' required step ' + step + ' has not passed' };
  }
  return { id: job.id };
}

// Pure attestation: callers supply GitHub REST run/job observations obtained
// using read-only trusted-main credentials, never from the PR or model.
export function attestPrWebQuality(sha, runsPayload, jobsPayload) {
  if (!SHA.test(String(sha))) throw new Error('exact PR HEAD SHA is required');
  if (!Array.isArray(runsPayload?.workflow_runs)) {
    return { status: 'pending', reason: 'Quality workflow run listing unavailable' };
  }
  const matching = runsPayload.workflow_runs.filter(run =>
    run?.name === 'CI / Quality Gate' &&
    [WORKFLOW, WORKFLOW + '@refs/heads/main'].includes(run.path) &&
    run.event === 'pull_request' && run.head_sha === sha &&
    run.repository?.full_name === REPO &&
    run.head_repository?.full_name === REPO &&
    positiveInteger(run.id) && positiveInteger(run.run_attempt));
  if (!matching.length) {
    return { status: 'pending', reason: 'no authenticated exact-HEAD PR Quality run' };
  }
  // A new run/attempt supersedes an earlier one; never borrow an earlier
  // successful attempt while its rerun is still pending or has failed.
  matching.sort((a,b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) ||
    b.id - a.id);
  const run = matching[0];
  if (!Array.isArray(jobsPayload?.jobs) ||
      jobsPayload.total_count > 100 || jobsPayload.jobs.length > 100) {
    return { status: 'pending', reason: 'exact-attempt Quality jobs unavailable/incomplete' };
  }
  const web = successfulJob(jobsPayload.jobs, 'web-tests', GATE_STEP, run, run.run_attempt);
  const check = successfulJob(jobsPayload.jobs, 'web-check', CHECK_STEP, run, run.run_attempt);
  if (!web.id || !check.id) {
    const reason = [web.reason, check.reason].filter(Boolean).join('; ');
    const failed = jobsPayload.jobs.some(job =>
      ['web-tests','web-check'].includes(job.name) &&
      job.status === 'completed' &&
      ['failure','timed_out','cancelled','skipped'].includes(job.conclusion));
    return { status: failed ? 'fail' : 'pending', reason };
  }
  return {
    status: 'pass',
    receipt: {
      kind: 'pr_web_quality_execution_v1',
      repository: REPO,
      workflow: WORKFLOW,
      head_sha: sha,
      run_id: run.id,
      run_attempt: run.run_attempt,
      web_tests_job_id: web.id,
      web_check_job_id: check.id,
      web_gate_step: GATE_STEP,
      web_check_step: CHECK_STEP,
    },
  };
}

function githubJson(path) {
  return JSON.parse(execFileSync('gh', ['api', path], {
    encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

export function collectPrWebQuality(sha, request = githubJson) {
  if (!SHA.test(String(sha))) throw new Error('exact PR HEAD SHA is required');
  try {
    const q = new URLSearchParams({ head_sha: sha, event: 'pull_request', per_page: '25' });
    const runs = request('/repos/' + REPO + '/actions/workflows/ci-quality.yml/runs?' + q);
    if (!Array.isArray(runs?.workflow_runs)) {
      return { status: 'pending', reason: 'GitHub Quality run listing unavailable' };
    }
    const candidates = runs.workflow_runs.filter(run =>
      run?.name === 'CI / Quality Gate' &&
      [WORKFLOW, WORKFLOW + '@refs/heads/main'].includes(run.path) &&
      run.event === 'pull_request' && run.head_sha === sha &&
      run.repository?.full_name === REPO &&
      run.head_repository?.full_name === REPO &&
      positiveInteger(run.id) && positiveInteger(run.run_attempt))
      .sort((a,b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) ||
        b.id - a.id);
    if (!candidates.length) return attestPrWebQuality(sha, runs, null);
    const run = candidates[0];
    const jobs = request('/repos/' + REPO + '/actions/runs/' + run.id +
      '/attempts/' + run.run_attempt + '/jobs?per_page=100');
    return attestPrWebQuality(sha, runs, jobs);
  } catch (error) {
    console.error('Trusted PR Quality readback failed:', error instanceof Error ? error.message : String(error));
    return { status: 'pending', reason: 'authenticated GitHub Quality readback unavailable' };
  }
}

export function enforcePrWebQuality(context, normalized) {
  if (context.stage !== 'pr') return normalized;
  const required = new Set((context.criteria ?? [])
    .filter(item => requiresWebIntegrationExecution(item, context.requirement_body))
    .map(item => item.criterion));
  if (!required.size) return normalized;
  const observation = context.pr_web_quality;
  const receipt = observation?.status === 'pass' &&
    validWebQualityReceipt(observation.receipt, context.target_ref)
    ? observation.receipt : null;
  const criteria = normalized.criteria.map(item => {
    if (!required.has(item.criterion) || item.result !== 'Pass') return item;
    if (!receipt) {
      return {
        ...item, result: 'Pending',
        summary: 'Required exact-HEAD Web integration execution not verified: ' +
          String(observation?.reason ?? 'missing authenticated Quality Gate receipt').slice(0,240),
        evidence: [{ type: 'quality-gate', value: 'Pending: required Web Gate is not completed successfully at ' +
          context.target_ref }],
      };
    }
    return { ...item, evidence: [...item.evidence, {
      type: 'quality-gate',
      value: 'CI / Quality Gate run ' + receipt.run_id + '/' + receipt.run_attempt +
        ' head ' + receipt.head_sha + ' web-tests job ' + receipt.web_tests_job_id +
        ' web-check job ' + receipt.web_check_job_id + ': succeeded',
    }] };
  });
  return {
    ...normalized, criteria,
    ...(receipt ? { pr_web_quality_receipt: receipt } : {}),
  };
}

function selfTest() {
  const sha = 'a'.repeat(40), other = 'b'.repeat(40);
  const run = {
    id: 42, run_attempt: 2, name: 'CI / Quality Gate', path: WORKFLOW,
    event: 'pull_request', head_sha: sha, created_at: '2026-11-14T12:00:00Z',
    repository: { full_name: REPO }, head_repository: { full_name: REPO },
  };
  const job = (name,id,step) => ({
    id, run_id: 42, run_attempt: 2, name, status: 'completed', conclusion: 'success',
    steps: [{ name: step, status: 'completed', conclusion: 'success' }],
  });
  const jobs = { total_count: 2, jobs: [job('web-tests', 10, GATE_STEP),
    job('web-check', 11, CHECK_STEP)] };
  const runs = { workflow_runs: [run] };
  const pass = attestPrWebQuality(sha, runs, jobs);
  assert.equal(pass.status, 'pass');
  assert.equal(pass.receipt.run_attempt, 2);
  assert.equal(attestPrWebQuality(other, runs, jobs).status, 'pending');
  assert.equal(attestPrWebQuality(sha, runs, null).status, 'pending');
  assert.equal(attestPrWebQuality(sha, runs, { jobs: [] }).status, 'pending');
  assert.equal(attestPrWebQuality(sha, runs, { jobs: [jobs.jobs[0]] }).status, 'pending');
  assert.equal(attestPrWebQuality(sha, runs, { jobs: [{ ...jobs.jobs[0], status: 'in_progress', conclusion: null }, jobs.jobs[1]] }).status, 'pending');
  assert.equal(attestPrWebQuality(sha, runs, { jobs: [{ ...jobs.jobs[0], conclusion: 'failure' }, jobs.jobs[1]] }).status, 'fail');
  assert.equal(attestPrWebQuality(sha, runs, { jobs: [{ ...jobs.jobs[0], conclusion: 'skipped' }, jobs.jobs[1]] }).status, 'fail');
  assert.equal(attestPrWebQuality(sha, runs, { jobs: [{ ...jobs.jobs[0], run_attempt: 1 }, jobs.jobs[1]] }).status, 'pending');
  assert.equal(attestPrWebQuality(sha, runs, { jobs: [{ ...jobs.jobs[0], steps: [] }, jobs.jobs[1]] }).status, 'pending');
  assert.equal(attestPrWebQuality(sha, { workflow_runs: [{ ...run, head_sha: other }] }, jobs).status, 'pending');
  const previousRun = { ...run, id: 41, run_attempt: 1, created_at: '2026-11-14T11:00:00Z' };
  const newestPending = { workflow_runs: [previousRun, run] };
  assert.equal(attestPrWebQuality(sha, newestPending, {
    jobs: [job('web-tests', 10, GATE_STEP), { ...jobs.jobs[1], status: 'in_progress', conclusion: null }],
  }).status, 'pending');
  const body = 'Scenario mapping: SCN-01 Web integration fixtures; exact PR HEAD Quality/Web.';
  const executable = { criterion: 'SC-03', text: 'A deterministic integration test records bounded requests and checks navigation-away behavior.' };
  const staticSc = { criterion: 'SC-01', text: 'Opening an App Files directory issues a bounded number of requests.' };
  const governance = { criterion: 'SC-02', text: 'For a PR SC explicitly requiring executable Web integration-test evidence, source review cannot produce Pass.' };
  assert.equal(requiresWebIntegrationExecution(executable, body), true);
  assert.equal(requiresWebIntegrationExecution(staticSc, body), false);
  assert.equal(requiresWebIntegrationExecution(governance, body), false);
  assert.equal(requiresWebIntegrationExecution(executable, 'Rust backend integration tests'), false);
  const context = {
    stage: 'pr', target_ref: sha, requirement_body: body,
    criteria: [staticSc, executable], pr_web_quality: { status: 'pending', reason: 'web-tests in progress' },
  };
  const result = {
    criteria: [{ criterion: 'SC-01', result: 'Pass', evidence: [{ type: 'source', value: 'source only' }] },
      { criterion: 'SC-03', result: 'Pass', evidence: [{ type: 'source', value: 'test source only' }] }],
  };
  const pending = enforcePrWebQuality(context, result);
  assert.equal(pending.criteria[0].result, 'Pass');
  assert.equal(pending.criteria[1].result, 'Pending');
  assert.match(pending.criteria[1].summary, /web-tests in progress/);
  assert.equal(enforcePrWebQuality({ ...context, pr_web_quality: pass }, result).criteria[1].result, 'Pass');
  assert.equal(validWebQualityReceipt(enforcePrWebQuality({ ...context, pr_web_quality: pass }, result).pr_web_quality_receipt, sha), true);
  assert.equal(enforcePrWebQuality({ ...context, pr_web_quality: { status: 'pass', receipt: { ...pass.receipt, head_sha: other } } }, result).criteria[1].result, 'Pending');
  assert.deepEqual(enforcePrWebQuality({ ...context, stage: 'staging' }, result), result);
  console.log('PR Web Quality receipt self-test: pending/fail/skip/SHA/attempt/jobs/steps and scoped Pass passed');
}

if (process.argv[1]?.endsWith('/acceptance-pr-web-quality-receipt.mjs') && process.argv[2] === 'self-test') {
  selfTest();
}
