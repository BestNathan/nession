// Job-scoped Acceptance Case batch receipt (#1866 SC-04/SC-08).
//
// The batch runs inside a CI job and writes its records and `batch.log` into
// the job's artifact. The Acceptance harness compacts evidence to run metadata
// and NEVER reads workflow artifacts, so "two or more Cases shared one
// job-owned runtime" was unobservable to every evaluator even when it really
// happened. This receipt carries the bounded measurement through the one
// channel that does reach an evaluator: the job log, re-read independently
// from GitHub exactly like the Metrics replay denial and the Run Store policy
// observability receipts.
//
// The producer runs as target code, so its claim is untrusted until the trusted
// collector binds it to the exact Run/Attempt/SHA and to the canonical workflow
// job that emitted it. The receipt can only describe what ran; it never grants
// a verdict by itself.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const ACCEPTANCE_BATCH_LOG_PREFIX = 'ACCEPTANCE_BATCH_RECEIPT_V1 ';
// Only canonical workflows may produce acceptance batch evidence. A PR may add
// a new workflow that calls the batch CLI, but the collector will never read
// its log as acceptance evidence.
export const ACCEPTANCE_BATCH_WORKFLOWS = Object.freeze([
  Object.freeze({
    workflow: '.github/workflows/acceptance-cases.yml',
    name: 'Acceptance / Cases',
    job: 'execute',
    events: Object.freeze(['push']),
  }),
  Object.freeze({
    workflow: '.github/workflows/acceptance-case-smoke.yml',
    name: 'Acceptance / Case Smoke',
    job: 'case-smoke',
    events: Object.freeze(['pull_request']),
  }),
]);
export const ACCEPTANCE_BATCH_RESULTS = Object.freeze(['Pass', 'Fail', 'Pending', 'N/A', 'Error']);
export const ACCEPTANCE_BATCH_STAGES = Object.freeze(['pre-merge', 'staging', 'post-merge']);
export const REPO = 'BestNathan/nession';
const SHA = /^[a-f0-9]{40}$/;
const CRITERION = /^SC-\d{2,}$/;
const POS = (x) => Number.isSafeInteger(x) && x > 0;
const COUNT = (x) => Number.isSafeInteger(x) && x >= 0;
const MAX_CASES = 64;

function normalizeWorkflowPath(value) {
  return String(value ?? '').replace(/@refs\/[^\s]+$/, '');
}

// `GITHUB_WORKFLOW_REF` is `owner/repo/.github/workflows/<file>@<ref>`; the
// runner sets it, and REST independently reports the same path on the run.
function workflowPathFromEnv(env) {
  const ref = String(env?.GITHUB_WORKFLOW_REF ?? '');
  const index = ref.indexOf('/.github/workflows/');
  if (index < 0) return null;
  return normalizeWorkflowPath(ref.slice(index + 1));
}

function positiveInt(x) {
  const parsed = Number(x);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// A receipt is emitted only from the canonical repository run. Nothing about a
// local or foreign run is evidence for this repository's acceptance.
function telemetry(env) {
  if (env?.GITHUB_REPOSITORY !== REPO) return null;
  const runId = positiveInt(env.GITHUB_RUN_ID);
  const runAttempt = positiveInt(env.GITHUB_RUN_ATTEMPT);
  const workflow = workflowPathFromEnv(env);
  const canonical = ACCEPTANCE_BATCH_WORKFLOWS.find((entry) => entry.workflow === workflow);
  if (runId === null || runAttempt === null || !canonical) return null;
  return { run_id: runId, run_attempt: runAttempt, workflow: canonical.workflow };
}

/**
 * Build the bounded receipt from what the batch actually executed.
 *
 * `placement` maps `issue|criterion` to the plan's batch decision so each Case
 * keeps its own attribution; Cases that produced no record (preparation errors)
 * are counted, never invented. `stageOf` resolves the effective stage a Case
 * ran at (workflows may mix per-Case stages, e.g. the PR smoke plan).
 */
export function makeAcceptanceBatchReceipt({
  env,
  runId,
  runAttempt,
  sha,
  stage,
  selectionCount,
  records,
  errors,
  sharedRuntimeCount,
  placement,
  stageOf = () => stage,
}) {
  const id = telemetry(env);
  if (!id) return null;
  const run = positiveInt(runId);
  const attempt = positiveInt(runAttempt);
  if (run === null || attempt === null || run !== id.run_id || attempt !== id.run_attempt) {
    return null;
  }
  if (!SHA.test(String(sha ?? '')) || !ACCEPTANCE_BATCH_STAGES.includes(stage) ||
      !Array.isArray(records) || !Array.isArray(errors) ||
      !Number.isSafeInteger(selectionCount) || selectionCount <= 0 ||
      records.length === 0 ||
      records.length > MAX_CASES || selectionCount > MAX_CASES ||
      records.length + errors.length > selectionCount ||
      !COUNT(sharedRuntimeCount) || sharedRuntimeCount > selectionCount ||
      !(placement instanceof Map)) {
    return null;
  }
  const cases = [];
  const executionIds = new Set();
  const sharedBatches = new Set();
  for (const record of records) {
    const issue = record?.issue;
    const criterion = record?.criterion;
    const key = String(issue) + '|' + String(criterion);
    const where = placement.get(key);
    const caseStage = stageOf(record, where);
    const profile = record?.runtime_profile ?? where?.profile ?? null;
    if (!Number.isSafeInteger(issue) || issue <= 0 || !CRITERION.test(String(criterion)) ||
        !(profile === null ||
          (typeof profile === 'string' && profile.length > 0 && profile.length <= 100)) ||
        !ACCEPTANCE_BATCH_RESULTS.includes(record?.result) ||
        !ACCEPTANCE_BATCH_STAGES.includes(caseStage) ||
        !SHA.test(String(record?.case_tree_sha ?? '')) ||
        !/^[a-f0-9]{64}$/.test(String(record?.contract_sha256 ?? '')) ||
        !/^[a-f0-9]{64}$/.test(String(record?.execution_id ?? '')) ||
        !where || !['shared', 'isolated'].includes(where.isolation) ||
        !Number.isSafeInteger(where.batch_index) || where.batch_index < 0 ||
        executionIds.has(record.execution_id)) {
      return null;
    }
    executionIds.add(record.execution_id);
    if (where.isolation === 'shared') sharedBatches.add(where.batch_index);
    cases.push(Object.freeze({
      issue,
      criterion: String(criterion),
      result: record.result,
      stage: caseStage,
      isolation: where.isolation,
      // The profile the Case declared and executed at; a shared batch only
      // ever contains one profile because the planner refuses to mix them.
      profile,
      batch_index: where.batch_index,
      execution_id: record.execution_id,
      contract_sha256: record.contract_sha256,
      case_tree_sha: record.case_tree_sha,
    }));
  }
  // A shared batch is only a fact when a resolved runtime actually started for
  // it. `startFullStackRuntime` resolves after server/agent/web readiness, so
  // every shared runtime counted here was proven ready before any Case ran.
  if (sharedBatches.size > 0 && sharedRuntimeCount < 1) return null;
  if (sharedRuntimeCount > sharedBatches.size) return null;
  return Object.freeze({
    schema_version: 1,
    kind: 'acceptance_case_batch',
    repository: REPO,
    workflow: id.workflow,
    run_id: run,
    run_attempt: attempt,
    sha,
    stage,
    stages: Object.freeze([...new Set(cases.map((item) => item.stage))].sort()),
    selected_count: selectionCount,
    case_count: cases.length,
    error_count: errors.length,
    shared_batch_count: sharedBatches.size,
    shared_ready_runtimes: sharedRuntimeCount,
    cases: Object.freeze(cases),
  });
}

export function validateAcceptanceBatchReceipt(receipt) {
  const canonical = ACCEPTANCE_BATCH_WORKFLOWS.find(
    (entry) => entry.workflow === receipt?.workflow,
  );
  if (receipt?.schema_version !== 1 || receipt.kind !== 'acceptance_case_batch' ||
      receipt.repository !== REPO || !canonical ||
      !POS(receipt.run_id) || !POS(receipt.run_attempt) ||
      !SHA.test(receipt.sha ?? '') || !ACCEPTANCE_BATCH_STAGES.includes(receipt.stage) ||
      !POS(receipt.selected_count) || receipt.selected_count > MAX_CASES ||
      !POS(receipt.case_count) || receipt.case_count > receipt.selected_count ||
      !COUNT(receipt.error_count) ||
      receipt.case_count + receipt.error_count > receipt.selected_count ||
      !COUNT(receipt.shared_batch_count) ||
      receipt.shared_batch_count > receipt.case_count ||
      !COUNT(receipt.shared_ready_runtimes) ||
      receipt.shared_ready_runtimes > receipt.shared_batch_count ||
      !Array.isArray(receipt.cases) || receipt.cases.length !== receipt.case_count ||
      !Array.isArray(receipt.stages) || receipt.stages.length === 0 ||
      receipt.stages.some((item) => !ACCEPTANCE_BATCH_STAGES.includes(item)) ||
      new Set(receipt.stages).size !== receipt.stages.length) {
    throw Error('invalid Acceptance Case batch receipt');
  }
  const executionIds = new Set();
  const sharedBatches = new Set();
  const stages = new Set();
  for (const item of receipt.cases) {
    if (!Number.isSafeInteger(item?.issue) || item.issue <= 0 ||
        !CRITERION.test(String(item?.criterion)) ||
        !(item?.profile === null ||
          (typeof item?.profile === 'string' && item.profile.length > 0 &&
           item.profile.length <= 100)) ||
        !ACCEPTANCE_BATCH_RESULTS.includes(item?.result) ||
        !ACCEPTANCE_BATCH_STAGES.includes(item?.stage) ||
        !['shared', 'isolated'].includes(item?.isolation) ||
        !Number.isSafeInteger(item?.batch_index) || item.batch_index < 0 ||
        !/^[a-f0-9]{64}$/.test(String(item?.execution_id ?? '')) ||
        !/^[a-f0-9]{64}$/.test(String(item?.contract_sha256 ?? '')) ||
        !SHA.test(String(item?.case_tree_sha ?? '')) ||
        executionIds.has(item.execution_id)) {
      throw Error('invalid Acceptance Case batch receipt entry');
    }
    executionIds.add(item.execution_id);
    stages.add(item.stage);
    if (item.isolation === 'shared') sharedBatches.add(item.batch_index);
  }
  if (sharedBatches.size !== receipt.shared_batch_count ||
      (sharedBatches.size > 0) !== (receipt.shared_ready_runtimes > 0) ||
      [...stages].sort().join(',') !== [...receipt.stages].sort().join(',')) {
    throw Error('Acceptance Case batch receipt isolation/stage mismatch');
  }
  const allowed = new Set(['schema_version', 'kind', 'repository', 'workflow',
    'run_id', 'run_attempt', 'sha', 'stage', 'stages', 'selected_count',
    'case_count', 'error_count', 'shared_batch_count', 'shared_ready_runtimes',
    'cases']);
  if (Object.keys(receipt).some((key) => !allowed.has(key))) {
    throw Error('unexpected Acceptance Case batch receipt fields');
  }
  const caseKeys = new Set(['issue', 'criterion', 'result', 'stage', 'isolation',
    'profile', 'batch_index', 'execution_id', 'contract_sha256', 'case_tree_sha']);
  for (const item of receipt.cases) {
    if (Object.keys(item).some((key) => !caseKeys.has(key))) {
      throw Error('unexpected Acceptance Case batch receipt case fields');
    }
  }
  return receipt;
}

// The receipt is an untrusted claim until GitHub REST independently binds it to
// the exact Run/Attempt/SHA and to the completed canonical job that produced it.
export function attestAcceptanceBatchReceipt(receipt, run, job) {
  validateAcceptanceBatchReceipt(receipt);
  const canonical = ACCEPTANCE_BATCH_WORKFLOWS.find(
    (entry) => entry.workflow === receipt.workflow,
  );
  if (run?.id !== receipt.run_id || run?.run_attempt !== receipt.run_attempt ||
      run?.head_sha !== receipt.sha ||
      !canonical.events.includes(run?.event) ||
      run?.name !== canonical.name ||
      normalizeWorkflowPath(run?.path) !== canonical.workflow ||
      run?.repository?.full_name !== REPO ||
      run?.head_repository?.full_name !== REPO ||
      run?.status !== 'completed' ||
      !['success', 'failure'].includes(run?.conclusion) ||
      job?.name !== canonical.job ||
      job?.run_id !== receipt.run_id || job?.run_attempt !== receipt.run_attempt ||
      job?.head_sha !== receipt.sha || job?.status !== 'completed' ||
      !['success', 'failure'].includes(job?.conclusion)) {
    throw Error('Acceptance Case batch receipt Run/Attempt/job provenance mismatch');
  }
  return Object.freeze({
    kind: 'verified_acceptance_case_batch',
    workflow: receipt.workflow,
    run_id: receipt.run_id,
    run_attempt: receipt.run_attempt,
    sha: receipt.sha,
    stage: receipt.stage,
    stages: receipt.stages,
    event: run.event,
    branch: run.head_branch ?? null,
    run_conclusion: run.conclusion,
    job_conclusion: job.conclusion,
    selected_count: receipt.selected_count,
    case_count: receipt.case_count,
    error_count: receipt.error_count,
    shared_batch_count: receipt.shared_batch_count,
    shared_ready_runtimes: receipt.shared_ready_runtimes,
    // Two or more Cases on one resolved runtime is the only shape that proves
    // reuse; every Case still carries its own execution id and records.
    cases_sharing_one_runtime: receipt.cases
      .filter((item) => item.isolation === 'shared').length,
    independent_case_records: true,
    cases: receipt.cases,
    evidence: 'GitHub API Run/Attempt/job outcomes + exact original canonical ' +
      'job log receipt emitted by the job-scoped Acceptance Case batch',
  });
}

// Only one receipt line may exist. Duplicated or ambiguous framing is rejected
// rather than guessed.
export function parseAcceptanceBatchLog(log) {
  if (typeof log !== 'string' || log.length > 4194304) {
    throw Error('invalid Acceptance Case batch log size');
  }
  const candidates = log.split(/\r?\n/)
    .filter((line) => line.includes(ACCEPTANCE_BATCH_LOG_PREFIX));
  if (candidates.length !== 1) return null;
  const match = candidates[0].match(/ACCEPTANCE_BATCH_RECEIPT_V1 (\{.*\})\s*$/);
  if (!match || match[1].length > 65536) {
    throw Error('invalid Acceptance Case batch record framing');
  }
  return validateAcceptanceBatchReceipt(JSON.parse(match[1]));
}

function selfTest() {
  const sha = 'a'.repeat(40);
  const env = {
    GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '39000000001', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF: REPO + '/.github/workflows/acceptance-cases.yml@refs/heads/main',
  };
  const record = (issue, criterion, result = 'Pass') => ({
    issue, criterion, result,
    runtime_profile: 'full-stack-local',
    execution_id: crypto.createHash('sha256')
      .update(issue + '/' + criterion).digest('hex'),
    contract_sha256: 'c'.repeat(64),
    case_tree_sha: sha,
  });
  const placement = new Map([
    ['1474|SC-09', { batch_index: 0, isolation: 'shared', profile: 'full-stack-local' }],
    ['1474|SC-10', { batch_index: 0, isolation: 'shared', profile: 'full-stack-local' }],
    ['1474|SC-11', { batch_index: 1, isolation: 'isolated', profile: 'full-stack-local' }],
  ]);
  const args = {
    env, runId: 39000000001, runAttempt: 1, sha, stage: 'post-merge',
    selectionCount: 3,
    records: [record(1474, 'SC-09'), record(1474, 'SC-10'), record(1474, 'SC-11', 'Fail')],
    errors: [], sharedRuntimeCount: 1, placement,
  };
  const receipt = makeAcceptanceBatchReceipt(args);
  assert.equal(validateAcceptanceBatchReceipt(receipt).case_count, 3);
  assert.equal(receipt.shared_batch_count, 1);
  assert.equal(receipt.shared_ready_runtimes, 1);
  assert.equal(receipt.cases[2].isolation, 'isolated');
  assert.deepEqual(receipt.stages, ['post-merge']);

  const run = {
    id: 39000000001, run_attempt: 1, head_sha: sha, head_branch: 'main', event: 'push',
    name: 'Acceptance / Cases', path: '.github/workflows/acceptance-cases.yml',
    repository: { full_name: REPO }, head_repository: { full_name: REPO },
    status: 'completed', conclusion: 'failure',
  };
  const job = {
    name: 'execute', run_id: 39000000001, run_attempt: 1, head_sha: sha,
    status: 'completed', conclusion: 'failure',
  };
  const attested = attestAcceptanceBatchReceipt(receipt, run, job);
  assert.equal(attested.cases_sharing_one_runtime, 2);
  assert.equal(attested.independent_case_records, true);
  assert.equal(attestAcceptanceBatchReceipt(receipt,
    { ...run, path: '.github/workflows/acceptance-cases.yml@refs/heads/main' }, job).sha, sha);

  const reject = (fn, pattern) => assert.throws(fn, pattern);
  // A forged or foreign origin never produces a receipt.
  assert.equal(makeAcceptanceBatchReceipt({
    ...args, env: { ...env, GITHUB_REPOSITORY: 'x/y' } }), null);
  assert.equal(makeAcceptanceBatchReceipt({
    ...args, env: { ...env, GITHUB_RUN_ID: 'x' } }), null);
  assert.equal(makeAcceptanceBatchReceipt({
    ...args, env: { ...env, GITHUB_WORKFLOW_REF: REPO + '/.github/workflows/ci-other.yml@refs/heads/main' } }),
  null);
  assert.equal(makeAcceptanceBatchReceipt({ ...args, sha: 'short' }), null);
  assert.equal(makeAcceptanceBatchReceipt({ ...args, stage: 'deployed' }), null);
  assert.equal(makeAcceptanceBatchReceipt({ ...args, records: [] }), null);
  assert.equal(makeAcceptanceBatchReceipt({ ...args, selectionCount: 2 }), null);
  // Two Cases that claim a shared batch need a started runtime.
  assert.equal(makeAcceptanceBatchReceipt({ ...args, sharedRuntimeCount: 0 }), null);
  // A duplicate execution id means the verdicts are not independent records.
  assert.equal(makeAcceptanceBatchReceipt({
    ...args, records: [record(1474, 'SC-09'), { ...record(1474, 'SC-10'),
      execution_id: record(1474, 'SC-09').execution_id }],
  }), null);
  // A Case missing from the plan cannot be attributed.
  assert.equal(makeAcceptanceBatchReceipt({
    ...args, records: [...args.records, record(1474, 'SC-12')],
    selectionCount: 4,
  }), null);
  // Per-Case stages are preserved and validated.
  const mixed = makeAcceptanceBatchReceipt({
    ...args,
    stage: 'pre-merge',
    stageOf: (item) => (item.criterion === 'SC-11' ? 'staging' : 'pre-merge'),
  });
  assert.deepEqual(mixed.stages, ['pre-merge', 'staging']);
  assert.equal(makeAcceptanceBatchReceipt({
    ...args, stageOf: () => 'deployed' }), null);

  // The smoke workflow is a canonical producer with its own job/event identity.
  const smokeEnv = {
    ...env,
    GITHUB_WORKFLOW_REF: REPO + '/.github/workflows/acceptance-case-smoke.yml@refs/heads/feat/x',
  };
  const smoke = makeAcceptanceBatchReceipt({ ...args, env: smokeEnv, stage: 'pre-merge' });
  assert.equal(smoke.workflow, '.github/workflows/acceptance-case-smoke.yml');
  const smokeRun = {
    ...run, event: 'pull_request', head_branch: 'feat/x',
    name: 'Acceptance / Case Smoke',
    path: '.github/workflows/acceptance-case-smoke.yml',
  };
  const smokeJob = { ...job, name: 'case-smoke' };
  assert.equal(attestAcceptanceBatchReceipt(smoke, smokeRun, smokeJob).event, 'pull_request');

  // Origin, SHA, event, branch identity and job identity are all bound.
  reject(() => attestAcceptanceBatchReceipt(receipt, { ...run, head_sha: 'b'.repeat(40) },
    job), /mismatch/);
  reject(() => attestAcceptanceBatchReceipt(receipt, { ...run, event: 'pull_request' },
    job), /mismatch/);
  reject(() => attestAcceptanceBatchReceipt(receipt, run,
    { ...job, conclusion: 'cancelled' }), /mismatch/);
  reject(() => attestAcceptanceBatchReceipt(receipt, run,
    { ...job, name: 'publish' }), /mismatch/);
  reject(() => attestAcceptanceBatchReceipt(receipt, run,
    { ...job, run_attempt: 2 }), /mismatch/);
  reject(() => attestAcceptanceBatchReceipt(smoke, run, job), /mismatch/);
  // A mutated receipt is refused, not trusted.
  reject(() => validateAcceptanceBatchReceipt({ ...receipt, shared_ready_runtimes: 0 }),
    /isolation\/stage mismatch/);
  reject(() => validateAcceptanceBatchReceipt({ ...receipt, case_count: 2 }), /invalid/);
  reject(() => validateAcceptanceBatchReceipt({ ...receipt, stages: ['staging'] }),
    /isolation\/stage mismatch/);
  reject(() => validateAcceptanceBatchReceipt({ ...receipt, protected: true }),
    /unexpected/);

  const line = 'job step output\n' + ACCEPTANCE_BATCH_LOG_PREFIX + JSON.stringify(receipt) + '\n';
  assert.equal(parseAcceptanceBatchLog(line).case_count, 3);
  assert.equal(parseAcceptanceBatchLog('no receipt here'), null);
  // Two receipts in one job log are ambiguous, never merged or guessed.
  assert.equal(parseAcceptanceBatchLog(line + ACCEPTANCE_BATCH_LOG_PREFIX +
    JSON.stringify(receipt) + '\n'), null);
  reject(() => parseAcceptanceBatchLog(ACCEPTANCE_BATCH_LOG_PREFIX + '{"not":'), /framing/);
  console.log('acceptance-batch-receipt self-test passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  selfTest();
}
