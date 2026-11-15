#!/usr/bin/env node
// Trusted-main PR Acceptance proof boundary for explicitly required Web tests.
// Model prose/test source is never evidence that a GitHub Quality Gate executed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const REPO = 'BestNathan/nession';
const WORKFLOW = '.github/workflows/ci-quality.yml';
const SHA = /^[a-f0-9]{40}$/i;
const GATE_STEP = 'Verify Web and design Gates';
const CHECK_STEP = 'Enforce applicable Quality results at the stable check name';

// A criterion can require executed Web Quality in two explicit ways:
// (1) its own text demands integration-test/Gate execution;
// (2) the Issue's scoped SCN-01 mapping explicitly binds that SC to Web
// unit-test CI and an independent exact-head CI receipt as a Pass condition.
// Merely mentioning a test file or policy is never an execution obligation.
// One classifier owns both, not a separate CI/Acceptance test catalog.
export function requiresWebIntegrationExecution(criterion, issueBody = '') {
  const text = String(criterion?.text ?? '');
  if (!/\bweb\b|\bchromium\b|\.tsx\b|web-test-integration/i.test(String(issueBody))) return false;
  const executedTest = /\bintegration[ -]+tests?\s+(?:records?|checks?|verifies?|asserts?|runs?|executes?|passes?|covers?|fails?)\b|\b(?:run|execute|pass|verify)\s+(?:the\s+)?(?:deterministic\s+)?(?:web\s+)?integration[ -]+tests?\b/i.test(text);
  // #3528 SC-02 says the commit "passes the source-aligned Web
  // Integration/Quality check", not "an integration test records ...".
  // This is also an executable exact-head obligation, unlike policy text
  // which merely describes when a future criterion may be accepted.
  const gateResult = /\b(?:pass(?:es|ed)?|succeed(?:s|ed)?|complete(?:s|d)?|execut(?:e|ed)|verif(?:y|ies))\b.{0,130}\b(?:web-test-integration|web[ -]+integration(?:\/quality)?|web[ -]+quality)\b/i.test(text) ||
    /\b(?:web-test-integration|web[ -]+integration\/quality)\b.{0,100}\b(?:pass(?:ed)?|success|successful|green|completed|executed)\b/i.test(text);
  // #3552 / #3433: unit-test-backed behavior SCs often describe WHAT must
  // happen, while their SCN-01 mapping states HOW Pass is proved. This
  // mandatory, criterion-specific receipt contract cannot be replaced by
  // model inspection of source/test assertions. Keep the match narrow:
  // the same mapping line must name the SC, SCN-01, Web unit-test CI, and
  // an independent exact-SHA CI receipt REQUIRED for Pass.
  // Only the Issue's own SC → scenario mapping can bind mandatory CI
  // execution. Quoted contracts in Description/Reproduction (such as #3433
  // cited by #3552) describe *another* Requirement and must not bind this one.
  const mappingLines = [];
  let inMapping = false;
  for (const line of String(issueBody).split(/\r?\n/)) {
    if (/^\s*(?:#{1,6}\s+|\*\*)SC\s*(?:→|->)\s*scenario\s+mapping\b/i.test(line)) {
      inMapping = true;
    } else if (inMapping && (/^\s*#{1,6}\s+/.test(line) || /^\s*$/.test(line))) {
      inMapping = false;
    }
    if (inMapping) mappingLines.push(line);
  }
  const requiredUnitReceipt = /^SC-\d{2,}$/.test(String(criterion?.criterion ?? '')) &&
    mappingLines.some(line =>
      (line.match(/\bSC-\d{2,}\b/g) ?? []).includes(criterion.criterion) &&
      /\bSCN-01\b/.test(line) &&
      /\bWeb\s+unit[- ]test\s+CI\b/i.test(line) &&
      /\b(?:independent\s+)?exact[- ]SHA\s+CI\s+receipts?\s+(?:are\s+)?required\s+for\s+Pass\b/i.test(line));
  return executedTest || gateResult || requiredUnitReceipt;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function validWebQualityReceipt(receipt, sha) {
  return Boolean(receipt && SHA.test(String(sha)) &&
    receipt.kind === 'pr_web_quality_execution_v1' &&
    receipt.repository === REPO && receipt.workflow === WORKFLOW &&
    receipt.head_sha === sha && receipt.result === 'success' &&
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
function matchingQualityRuns(runs, sha) {
  return (Array.isArray(runs) ? runs : []).filter(run =>
    run?.name === 'CI / Quality Gate' &&
    [WORKFLOW, WORKFLOW + '@refs/heads/main'].includes(run.path) &&
    run.event === 'pull_request' && run.head_sha === sha &&
    run.repository?.full_name === REPO &&
    run.head_repository?.full_name === REPO &&
    positiveInteger(run.id) && positiveInteger(run.run_attempt))
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) ||
      b.id - a.id);
}

export function requiresPrToolingEvidence(context) {
  // SCN-05 is the existing CI/GitHub-governance proof scenario. Only
  // criteria that explicitly concern Gate/CI execution ask for this receipt.
  // It documents tested tooling, never a successful Web integration run.
  return context?.stage === 'pr' &&
    /\bSCN-05\b/.test(String(context.requirement_body ?? '')) &&
    (context.criteria ?? []).some(item =>
      /\b(?:CI|Quality|Gate|workflow|test)\b/i.test(String(item.text ?? '')));
}

export function attestPrWebQuality(sha, runsPayload, jobsPayload) {
  if (!SHA.test(String(sha))) throw new Error('exact PR HEAD SHA is required');
  if (!Array.isArray(runsPayload?.workflow_runs)) {
    return { status: 'pending', reason: 'Quality workflow run listing unavailable' };
  }
  const matching = matchingQualityRuns(runsPayload.workflow_runs, sha);
  if (!matching.length) {
    return { status: 'pending', reason: 'no authenticated exact-HEAD PR Quality run' };
  }
  // A new run/attempt supersedes an earlier one; never borrow an earlier
  // successful attempt while its rerun is still pending or has failed.
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
      result: 'success',
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
    const candidates = matchingQualityRuns(runs.workflow_runs, sha);
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


// This second typed receipt comes from the SAME PR Quality run selector as
// Web execution proof. It attests the canonical tooling self-test suite for
// CI-governance SCs (SCN-05). A skipped web-tests job is not promoted to Pass.
export function attestPrToolingQuality(sha, runsPayload, jobsPayload) {
  if (!SHA.test(String(sha))) throw new Error('exact PR HEAD SHA is required');
  const matching = matchingQualityRuns(runsPayload?.workflow_runs, sha);
  if (!matching.length) {
    return { status: 'pending', reason: 'no authenticated exact-HEAD PR Quality run' };
  }
  const run = matching[0];
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    return { status: run.status === 'completed' ? 'fail' : 'pending',
      reason: 'Quality workflow is ' + String(run.status ?? 'unknown') +
        '/' + String(run.conclusion ?? 'pending') };
  }
  if (!Array.isArray(jobsPayload?.jobs) || jobsPayload.total_count > 100 ||
      jobsPayload.jobs.length > 100) {
    return { status: 'pending', reason: 'exact-attempt Quality job evidence unavailable' };
  }
  const tooling = successfulJob(jobsPayload.jobs, 'tooling-check',
    'Verify repository tooling Gates', run, run.run_attempt);
  const aggregate = successfulJob(jobsPayload.jobs, 'web-check',
    CHECK_STEP, run, run.run_attempt);
  if (!tooling.id || !aggregate.id) {
    const reason = [tooling.reason, aggregate.reason].filter(Boolean).join('; ');
    const fail = jobsPayload.jobs.some(job =>
      ['tooling-check', 'web-check'].includes(job.name) &&
      job.status === 'completed' &&
      ['failure', 'timed_out', 'cancelled', 'skipped'].includes(job.conclusion));
    return { status: fail ? 'fail' : 'pending', reason };
  }
  return { status: 'pass', receipt: {
    kind: 'pr_tooling_quality_execution_v1', repository: REPO,
    workflow: WORKFLOW, head_sha: sha,
    run_id: run.id, run_attempt: run.run_attempt, result: 'success',
    tooling_job_id: tooling.id, aggregate_job_id: aggregate.id,
    tooling_gate_step: 'Verify repository tooling Gates',
    aggregate_step: CHECK_STEP,
    note: 'Verified Quality tooling Gates only; not a Web integration test receipt',
  }};
}

export function collectPrToolingQuality(sha, request = githubJson) {
  if (!SHA.test(String(sha))) throw new Error('exact PR HEAD SHA is required');
  try {
    const q = new URLSearchParams({head_sha: sha, event: 'pull_request', per_page: '25'});
    const runs = request('/repos/' + REPO + '/actions/workflows/ci-quality.yml/runs?' + q);
    const candidate = matchingQualityRuns(runs?.workflow_runs, sha)[0];
    const jobs = candidate ? request('/repos/' + REPO + '/actions/runs/' + candidate.id +
      '/attempts/' + candidate.run_attempt + '/jobs?per_page=100') : null;
    return attestPrToolingQuality(sha, runs, jobs);
  } catch (error) {
    console.error('Trusted PR tooling Quality readback failed:',
      error instanceof Error ? error.message : String(error));
    return { status: 'pending', reason: 'authenticated GitHub tooling Quality readback unavailable' };
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
  // Real SCN-05 fixtures must observe the successfully executed canonical
  // tooling suite while still refusing to claim a skipped Web test executed.
  const toolingJobs = { total_count: 2,
    jobs: [job('tooling-check', 12, 'Verify repository tooling Gates'),
      jobs.jobs[1]] };
  const completed = { workflow_runs: [{
    ...run, status: 'completed', conclusion: 'success',
  }] };
  const tooling = attestPrToolingQuality(sha, completed, toolingJobs);
  assert.equal(tooling.status, 'pass');
  assert.equal(tooling.receipt.tooling_job_id, 12);
  assert.equal(attestPrToolingQuality(sha, completed, {
    ...toolingJobs, jobs: [jobs.jobs[0], jobs.jobs[1]],
  }).status, 'pending');
  assert.equal(attestPrToolingQuality(sha, completed, {
    ...toolingJobs, jobs: [{ ...toolingJobs.jobs[0], conclusion: 'failure' }, jobs.jobs[1]],
  }).status, 'fail');
  assert.equal(attestPrToolingQuality(sha, completed, {
    ...toolingJobs, jobs: [{ ...toolingJobs.jobs[0], run_attempt: 1 }, jobs.jobs[1]],
  }).status, 'pending');
  assert.equal(attestPrToolingQuality(other, completed, toolingJobs).status, 'pending');
  assert.equal(attestPrToolingQuality(sha, { workflow_runs: [run] },
    toolingJobs).status, 'pending');
  assert.equal(requiresPrToolingEvidence({ stage: 'pr',
    requirement_body: 'SCN-05 (trusted CI / Workflow provenance)',
    criteria: [{ text: 'An exact-head Web Gate cannot Pass while pending' }] }), true);
  assert.equal(requiresPrToolingEvidence({ stage: 'pr',
    requirement_body: 'SCN-01 Web fixtures',
    criteria: [{ text: 'An exact-head Web Gate cannot Pass while pending' }] }), false);

  const body = 'Scenario mapping: SCN-01 Web integration fixtures; exact PR HEAD Quality/Web.';
  const executable = { criterion: 'SC-03', text: 'A deterministic integration test records bounded requests and checks navigation-away behavior.' };
  const staticSc = { criterion: 'SC-01', text: 'Opening an App Files directory issues a bounded number of requests.' };
  const governance = { criterion: 'SC-02', text: 'For a PR SC explicitly requiring executable Web integration-test evidence, source review cannot produce Pass.' };
  assert.equal(requiresWebIntegrationExecution(executable, body), true);
  assert.equal(requiresWebIntegrationExecution(staticSc, body), false);
  assert.equal(requiresWebIntegrationExecution(governance, body), false);
  // Real #3528 SC-02: positive exact-head Quality proof must be made visible
  // to Agent; the earlier implementation accidentally classified it as static.
  const qualitySc = { criterion: 'SC-02',
    text: 'The new test-only commit passes the source-aligned Web Integration/Quality check at its exact PR head and leaves the Issues list/row assertions intact.' };
  assert.equal(requiresWebIntegrationExecution(qualitySc, body), true);
  // Active verification verbs still require exact-head Web execution.
  const verifySc = { criterion: 'SC-04',
    text: 'The PR verifies the Web Quality check on its exact HEAD.' };
  assert.equal(requiresWebIntegrationExecution(verifySc, body), true);
  const policySc = { criterion: 'SC-01',
    text: 'For a PR SC explicitly requiring executable Web integration-test evidence, a successful source review of the test file cannot produce Pass while its exact-head Web Gate is pending.' };
  assert.equal(requiresWebIntegrationExecution(policySc, body), false);
  const governancePositive = { criterion: 'SC-02',
    text: 'Once the independent required exact-head Gate actually completes success, the existing source-aligned Agent/ingester may issue Pass.' };
  assert.equal(requiresWebIntegrationExecution(governancePositive, body), false);
  // #3433: each SC describes terminal behavior; the issue-level SCN-01
  // contract explicitly requires independent Web unit-test CI receipts.
  const unitBody = '### SC → scenario mapping\n' +
    'SC-01 and SC-02: **SCN-01**, deterministic Web transport contract. ' +
    'Existing ConnectionManager.test.ts / inputQueue.test.ts and Web unit-test CI ' +
    'provide the source-aligned PR-head lane; independent exact-SHA CI receipts are required for Pass.';
  const unit01 = { criterion: 'SC-01', text: 'A quiet reconnect drops expired terminal input before flush.' };
  const unit02 = { criterion: 'SC-02', text: 'A valid reconnect preserves only unapplied input in order.' };
  const unitStatic = { criterion: 'SC-03', text: 'The implementation docs name the timeout owner.' };
  assert.equal(requiresWebIntegrationExecution(unit01, unitBody), true);
  assert.equal(requiresWebIntegrationExecution(unit02, unitBody), true);
  assert.equal(requiresWebIntegrationExecution(unitStatic, unitBody), false);
  assert.equal(requiresWebIntegrationExecution(unit01,
    unitBody.replace('required for Pass', 'recorded for reference')), false);
  assert.equal(requiresWebIntegrationExecution(unit01,
    unitBody.replace('Web unit-test CI', 'Rust unit-test CI')), false);
  // #3552 is an Acceptance/CI classifier requirement, not a Web runtime
  // change. A quoted #3433 unit-test proof contract must not bind #3552's
  // own SCs, nor may "verified successful Web Quality run" be mistaken for
  // a requirement that this tooling-only PR executes Web tests.
  const governanceBody = '### Verified production counterexample\n' +
    '- [#3433] SC-01 and SC-02: SCN-01. Web unit-test CI provides source ' +
    'verification; independent exact-SHA CI receipts are required for Pass.\n\n' +
    '**SC → scenario mapping:** SC-01/02 → SCN-01 deterministic classifier ' +
    'fixtures + SCN-05 existing GitHub Quality proof.\n\n## Acceptance Plan';
  const governance01 = { criterion: 'SC-01',
    text: "#3433's exact SCN-01 Web unit-test-required contract cannot project " +
      'Pass while its PR-head web-tests or web-check fails or remains pending.' };
  const governance02 = { criterion: 'SC-02',
    text: 'A verified successful exact-SHA Web Quality run allows those SCs ' +
      'source-aligned Pass; static-only Web and Rust/governance SCs remain unaffected.' };
  assert.equal(requiresWebIntegrationExecution(governance01, governanceBody), false);
  assert.equal(requiresWebIntegrationExecution(governance02, governanceBody), false);
  const governanceContext = { stage: 'pr', target_ref: sha,
    requirement_body: governanceBody, criteria: [governance01, governance02],
    pr_web_quality: { status: 'fail', reason: 'web-tests completed/skipped' } };
  const governanceProposal = { criteria: [governance01, governance02].map(sc => ({
    criterion: sc.criterion, result: 'Pass',
    evidence: [{ type: 'source', value: 'source-aligned tooling proof' }],
  })) };
  assert.deepEqual(enforcePrWebQuality(governanceContext, governanceProposal),
    governanceProposal, 'tooling-only governance SCs must not inherit Web execution');
  assert.equal(requiresWebIntegrationExecution(unit01, unitBody), true,
    'the genuine #3433 unit-test execution obligation remains mandatory');

  const unitContext = { stage: 'pr', target_ref: sha, requirement_body: unitBody,
    criteria: [unit01,unit02,unitStatic],
    pr_web_quality: { status: 'fail', reason: 'web-tests completed/failure' } };
  const unitProposal = { criteria: [unit01,unit02,unitStatic].map(sc=>({
    criterion: sc.criterion, result:'Pass',
    evidence:[{type:'source',value:'source assertions only'}] })) };
  const unitBlocked = enforcePrWebQuality(unitContext, unitProposal);
  assert.equal(unitBlocked.criteria[0].result, 'Pending');
  assert.equal(unitBlocked.criteria[1].result, 'Pending');
  assert.equal(unitBlocked.criteria[2].result, 'Pass');
  assert.match(unitBlocked.criteria[0].summary, /web-tests completed\/failure/);
  assert.equal(enforcePrWebQuality({...unitContext,
    pr_web_quality:{status:'pending',reason:'Web Quality in_progress'}},
    unitProposal).criteria[0].result, 'Pending');
  const unitPassed = enforcePrWebQuality({...unitContext,pr_web_quality:pass},unitProposal);
  assert.equal(unitPassed.criteria[0].result, 'Pass');
  assert.equal(unitPassed.criteria[1].result, 'Pass');
  assert.equal(unitPassed.criteria[2].result, 'Pass');
  assert.equal(enforcePrWebQuality({...unitContext,pr_web_quality:{
    status:'pass',receipt:{...pass.receipt,head_sha:other}}},
    unitProposal).criteria[0].result, 'Pending');

  const qualityContext = {
    stage: 'pr', target_ref: sha, requirement_body: body,
    criteria: [staticSc, qualitySc], pr_web_quality: { status: 'pending', reason: 'Web Quality still running' },
  };
  const qualityResult = {
    criteria: [{ criterion: 'SC-01', result: 'Pass', evidence: [{ type: 'source', value: 'source only' }] },
      { criterion: 'SC-02', result: 'Pass', evidence: [{ type: 'source', value: 'test source only' }] }],
  };
  assert.equal(enforcePrWebQuality(qualityContext, qualityResult).criteria[1].result, 'Pending');
  assert.equal(enforcePrWebQuality({ ...qualityContext, pr_web_quality: pass },
    qualityResult).criteria[1].result, 'Pass');
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
