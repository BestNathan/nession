#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  applyAcceptanceResultToBody,
  buildAcceptanceContext,
  normalizeAcceptanceCaseResult,
} from './acceptance-executor.mjs';
import { parsePreMergeIssueNumbers } from './requirement-acceptance.mjs';

const RESULTS = new Set(['Pass', 'Fail', 'Pending', 'Error']);
const STAGES = new Set(['pre-merge', 'staging', 'post-merge']);

function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(label + ' must be a positive integer');
  return n;
}

function sha(value, length, label) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!new RegExp('^[0-9a-f]{' + length + '}$').test(text)) {
    throw new Error(label + ' must be a ' + length + '-character hex digest');
  }
  return text;
}

function singleLine(value, label) {
  const text = String(value ?? '').trim();
  if (!text || /[\r\n]/.test(text)) throw new Error(label + ' must be a non-empty single line');
  return text;
}

function aggregate(verifiers) {
  if (verifiers.some((item) => item.result === 'Error')) return 'Error';
  if (verifiers.some((item) => item.result === 'Fail')) return 'Fail';
  if (verifiers.some((item) => item.result === 'Pending')) return 'Pending';
  return verifiers.length > 0 && verifiers.every((item) => item.result === 'Pass')
    ? 'Pass'
    : 'Pending';
}

export function validateCaseRecord(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Case record must be an object');
  if (Number(raw.schema_version) !== 1 || raw.kind !== 'acceptance_case_result') {
    throw new Error('unsupported Case record schema');
  }
  const issue = positiveInt(raw.issue, 'issue');
  const criterion = String(raw.criterion ?? '').trim().toUpperCase();
  if (!/^SC-\d{2,}$/.test(criterion)) throw new Error('invalid Case criterion');
  const stage = String(raw.stage ?? '').trim();
  if (!STAGES.has(stage)) throw new Error('invalid Case stage');
  const targetSha = sha(raw.target_sha, 40, 'target_sha');
  const caseRevision = sha(raw.case_revision, 40, 'case_revision');
  if (caseRevision !== targetSha) {
    throw new Error('source-aligned Case revision must equal target_sha');
  }
  const caseTreeSha = sha(raw.case_tree_sha, 40, 'case_tree_sha');
  const contractSha256 = sha(raw.contract_sha256, 64, 'contract_sha256');
  const executionId = sha(raw.execution_id, 64, 'execution_id');
  const runId = positiveInt(raw.run_id, 'run_id');
  const runAttempt = positiveInt(raw.run_attempt, 'run_attempt');
  const result = String(raw.result ?? '');
  if (!RESULTS.has(result)) throw new Error('invalid Case result: ' + result);
  if (!Array.isArray(raw.verifiers) || raw.verifiers.length === 0) {
    throw new Error('Case record requires verifier outcomes');
  }
  for (const [index, verifier] of raw.verifiers.entries()) {
    if (!['browser', 'protocol', 'runtime'].includes(String(verifier.type))) {
      throw new Error('invalid verifier type at index ' + index);
    }
    if (!RESULTS.has(String(verifier.result))) {
      throw new Error('invalid verifier result at index ' + index);
    }
    for (const [evidenceIndex, evidence] of (verifier.evidence ?? []).entries()) {
      singleLine(evidence.type, 'verifier evidence type ' + index + '/' + evidenceIndex);
      singleLine(evidence.value, 'verifier evidence value ' + index + '/' + evidenceIndex);
    }
    if (verifier.result === 'Pass' && (!Array.isArray(verifier.evidence) || verifier.evidence.length === 0)) {
      throw new Error('passing verifier requires concrete evidence');
    }
  }
  const aggregated = aggregate(raw.verifiers);
  if (result !== aggregated) {
    throw new Error('Case result ' + result + ' disagrees with deterministic verifier aggregation ' + aggregated);
  }
  if (result === 'Pass' && raw.infrastructure_status !== 'ready') {
    throw new Error('passing Case requires ready infrastructure');
  }
  singleLine(raw.criterion_text, 'criterion_text');
  singleLine(raw.runtime_profile, 'runtime_profile');

  return {
    ...raw,
    issue,
    criterion,
    stage,
    target_sha: targetSha,
    case_revision: caseRevision,
    case_tree_sha: caseTreeSha,
    contract_sha256: contractSha256,
    execution_id: executionId,
    run_id: runId,
    run_attempt: runAttempt,
  };
}

// Bind untrusted JSON to the actual GitHub workflow_run event before ANY write.
// A digest of user-controlled fields alone is not an attestation.
export function sourceRunIdentity(event, repository) {
  const run = event?.workflow_run;
  if (!run || run.name !== 'Acceptance Cases') {
    throw new Error('expected a completed Acceptance Cases workflow_run event');
  }
  if (run.status !== 'completed' || !['success', 'failure'].includes(run.conclusion)) {
    throw new Error('source Acceptance Cases run has no terminal supported conclusion');
  }
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) {
    throw new Error('source workflow repository mismatch');
  }
  if (run.path && !String(run.path).includes('/.github/workflows/acceptance-cases.yml')) {
    throw new Error('unexpected source workflow definition path');
  }
  const branch = singleLine(run.head_branch, 'workflow_run.head_branch');
  const sourceSha = sha(run.head_sha, 40, 'workflow_run.head_sha');
  const eventName = singleLine(run.event, 'workflow_run.event');
  if (!['push', 'workflow_dispatch'].includes(eventName)) {
    throw new Error('unsupported source workflow event ' + eventName);
  }
  if (!['staging', 'main'].includes(branch)) {
    throw new Error('source workflow branch not eligible for ingestion: ' + branch);
  }
  return {
    repository,
    run_id: positiveInt(run.id, 'workflow_run.id'),
    run_attempt: positiveInt(run.run_attempt, 'workflow_run.run_attempt'),
    event: eventName,
    head_sha: sourceSha,
    head_branch: branch,
    workflow_id: positiveInt(run.workflow_id, 'workflow_run.workflow_id'),
  };
}

export function assertSourceBoundRecord(record, source) {
  const item = validateCaseRecord(record);
  if (item.run_id !== source.run_id || item.run_attempt !== source.run_attempt) {
    throw new Error('Case record run identity disagrees with triggering workflow_run');
  }
  // A manually dispatched run may check out a different SHA, but that SHA is
  // not authenticated by workflow_run.head_sha. Reject rather than project it.
  if (item.target_sha !== source.head_sha) {
    throw new Error('Case target SHA is not the authenticated source workflow head');
  }
  const expectedStage = source.head_branch === 'main' ? 'post-merge' : 'staging';
  if (item.stage !== expectedStage) {
    throw new Error('Case stage disagrees with authenticated workflow source branch');
  }
  const canonical = JSON.stringify({
    schema_version: 1,
    run_id: item.run_id,
    run_attempt: item.run_attempt,
    target_sha: item.target_sha,
    issue: item.issue,
    criterion: item.criterion,
    contract_sha256: item.contract_sha256,
    case_tree_sha: item.case_tree_sha,
  });
  const expected = crypto.createHash('sha256').update(canonical).digest('hex');
  if (item.execution_id !== expected) {
    throw new Error('Case execution_id does not match canonical source identity digest');
  }
  return item;
}

async function attestCaseRecord(record, { event, repository, token }) {
  const source = sourceRunIdentity(event, repository);
  const item = assertSourceBoundRecord(record, source);
  const [owner, repo] = repository.split('/');
  const commit = await githubRequest('/repos/' + owner + '/' + repo + '/git/commits/' + item.target_sha, { token });
  const tree = await githubRequest('/repos/' + owner + '/' + repo + '/git/trees/' + commit.tree.sha + '?recursive=1', { token });
  if (tree.truncated) throw new Error('source tree listing is truncated; cannot attest Case tree');
  const casePath = 'acceptance/cases/' + item.issue + '/' + item.criterion;
  const actual = tree.tree?.find((entry) => entry.path === casePath && entry.type === 'tree');
  if (!actual || actual.sha !== item.case_tree_sha) {
    throw new Error('Case Git tree does not match authenticated source SHA: ' + casePath);
  }
  return { item, source };
}

export function recordPath(record) {
  const item = validateCaseRecord(record);
  const date = String(item.finished_at ?? item.started_at ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Case record requires ISO started_at/finished_at');
  return [
    'runs',
    date,
    item.run_id + '-' + item.run_attempt,
    String(item.issue),
    item.criterion + '.json',
  ].join('/');
}

export function enrichCaseRecord(record, { workflowUrl, recordPath: durablePath, source = null }) {
  const item = validateCaseRecord(record);
  const sourceResultSha256 = crypto
    .createHash('sha256')
    .update(JSON.stringify(item))
    .digest('hex');
  return {
    ...item,
    provenance: {
      ...(item.provenance ?? {}),
      ...(source ? { verified_source: source } : {}),
      workflow_url: singleLine(workflowUrl, 'workflow_url'),
      record_path: singleLine(durablePath, 'record_path'),
      source_result_sha256: sourceResultSha256,
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function githubRequest(apiPath, { token, method = 'GET', body } = {}) {
  if (!token) throw new Error('GITHUB_TOKEN/GH_TOKEN is required');
  const attempts = 4;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch('https://api.github.com' + apiPath, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + token,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'nession-acceptance-case-ingest',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (response.ok) return response.status === 204 ? null : response.json();

      const detail = await response.text();
      const retriable = response.status === 429 || response.status >= 500;
      const error = new Error(
        'GitHub API ' + method + ' ' + apiPath + ' failed: ' + response.status + ' ' + detail,
      );
      if (!retriable || attempt === attempts) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }

    await sleep(250 * (2 ** (attempt - 1)));
  }

  throw lastError ?? new Error('GitHub API request failed without an error');
}

async function issueIsAssociatedWithSha(owner, name, issueNumber, targetSha, token) {
  const pulls = await githubRequest(
    '/repos/' + owner + '/' + name + '/commits/' + targetSha + '/pulls?per_page=100',
    { token },
  );
  for (const pr of pulls ?? []) {
    const numbers = parsePreMergeIssueNumbers(pr.body, owner, name, pr.title);
    if (numbers.includes(issueNumber)) return true;
  }
  return false;
}

async function currentStageSha(owner, name, stage, token) {
  const branch = stage === 'staging' ? 'staging' : stage === 'post-merge' ? 'main' : null;
  if (!branch) return null;
  const ref = await githubRequest('/repos/' + owner + '/' + name + '/git/ref/heads/' + branch, { token });
  return String(ref.object?.sha ?? '');
}

export async function applyCaseRecord(record, { repository, token }) {
  const item = validateCaseRecord(record);
  const [owner, name] = String(repository ?? '').split('/');
  if (!owner || !name) throw new Error('repository must be owner/name');

  if (item.stage === 'pre-merge') {
    return { projected: false, reason: 'pre-merge Case records are evidence-only; PR Acceptance owns pre-merge projection' };
  }

  const currentSha = await currentStageSha(owner, name, item.stage, token);
  if (currentSha !== item.target_sha) {
    return {
      projected: false,
      reason: 'historical target ' + item.target_sha + ' is not current ' + item.stage + ' SHA ' + currentSha,
    };
  }
  if (!await issueIsAssociatedWithSha(owner, name, item.issue, item.target_sha, token)) {
    return { projected: false, reason: 'target SHA is not associated with Requirement #' + item.issue };
  }

  const issue = await githubRequest('/repos/' + owner + '/' + name + '/issues/' + item.issue, { token });
  const labels = new Set((issue.labels ?? []).map((label) => typeof label === 'string' ? label : label.name));
  if (!labels.has('requirement')) throw new Error('#' + item.issue + ' is not a requirement');
  if (String(issue.state).toLowerCase() !== 'open') {
    return { projected: false, reason: 'Requirement #' + item.issue + ' is not open' };
  }

  const context = buildAcceptanceContext(issue, item.stage, {
    targetRef: item.target_sha,
    deployment: item.stage,
    runId: item.run_id,
  });
  const normalized = normalizeAcceptanceCaseResult(context, item, 'case-runner');
  const updatedBody = applyAcceptanceResultToBody(issue.body, normalized);
  if (updatedBody === issue.body) return { projected: true, changed: false };

  await githubRequest('/repos/' + owner + '/' + name + '/issues/' + item.issue, {
    token,
    method: 'PATCH',
    body: { body: updatedBody },
  });
  return { projected: true, changed: true };
}

function fixtureRecord(overrides = {}) {
  return {
    schema_version: 1,
    kind: 'acceptance_case_result',
    execution_id: 'a'.repeat(64),
    run_id: 100,
    run_attempt: 1,
    issue: 1474,
    criterion: 'SC-14',
    criterion_text: 'browser and protocol case completes',
    stage: 'staging',
    target_sha: 'b'.repeat(40),
    contract_sha256: 'c'.repeat(64),
    case_revision: 'b'.repeat(40),
    case_tree_sha: 'd'.repeat(40),
    runtime_profile: 'full-stack-local',
    result_policy: 'all-pass',
    result: 'Pass',
    infrastructure_status: 'ready',
    infrastructure_error: null,
    started_at: '2026-10-08T00:00:00.000Z',
    finished_at: '2026-10-08T00:00:01.000Z',
    duration_ms: 1000,
    verifiers: [{
      type: 'browser',
      entry: 'verify.spec.ts',
      result: 'Pass',
      summary: 'browser passed',
      evidence: [{ type: 'browser', value: 'shell visible' }],
    }],
    ...overrides,
  };
}

function selfTest() {
  const valid = fixtureRecord();
  const canonical = JSON.stringify({
    schema_version: 1, run_id: valid.run_id, run_attempt: valid.run_attempt,
    target_sha: valid.target_sha, issue: valid.issue, criterion: valid.criterion,
    contract_sha256: valid.contract_sha256, case_tree_sha: valid.case_tree_sha,
  });
  valid.execution_id = crypto.createHash('sha256').update(canonical).digest('hex');
  const source = {
    repository: 'BestNathan/nession', run_id: 100, run_attempt: 1,
    event: 'push', head_sha: valid.target_sha, head_branch: 'staging', workflow_id: 9,
  };
  assert.equal(assertSourceBoundRecord(valid, source).issue, 1474);
  assert.throws(() => assertSourceBoundRecord({ ...valid, run_id: 999 }, source), /run identity/);
  assert.throws(() => assertSourceBoundRecord({ ...valid, target_sha: 'e'.repeat(40), case_revision: 'e'.repeat(40) }, source), /target SHA/);
  assert.throws(() => assertSourceBoundRecord({ ...valid, stage: 'post-merge' }, source), /stage disagrees/);
  assert.throws(() => assertSourceBoundRecord({ ...valid, execution_id: 'a'.repeat(64) }, source), /execution_id/);
  const fixtureEvent = { workflow_run: {
    name: 'Acceptance Cases', status: 'completed', conclusion: 'success',
    repository: { full_name: 'BestNathan/nession' },
    head_repository: { full_name: 'BestNathan/nession' },
    head_branch: 'staging', head_sha: valid.target_sha, event: 'push',
    id: 100, run_attempt: 1, workflow_id: 9,
  }};
  assert.equal(sourceRunIdentity(fixtureEvent, 'BestNathan/nession').head_sha, valid.target_sha);
  assert.throws(() => sourceRunIdentity({ workflow_run: { ...fixtureEvent.workflow_run, repository: {full_name: 'other/repo'} } }, 'BestNathan/nession'), /repository mismatch/);
  assert.equal(validateCaseRecord(valid).result, 'Pass');
  assert.equal(recordPath(valid), 'runs/2026-10-08/100-1/1474/SC-14.json');
  assert.throws(() => validateCaseRecord({ ...valid, case_revision: 'e'.repeat(40) }), /must equal target_sha/);
  assert.throws(() => validateCaseRecord({ ...valid, result: 'Pending' }), /disagrees/);
  assert.throws(
    () => validateCaseRecord({ ...valid, verifiers: [{ ...valid.verifiers[0], evidence: [] }] }),
    /requires concrete evidence/,
  );
  const enriched = enrichCaseRecord(valid, {
    workflowUrl: 'https://github.com/BestNathan/nession/actions/runs/100',
    recordPath: recordPath(valid),
  });
  assert.match(enriched.provenance.source_result_sha256, /^[0-9a-f]{64}$/);
  console.log('acceptance Case ingest self-test: provenance and record validation passed');
}

async function main() {
  const command = process.argv[2];
  if (command === 'self-test') return selfTest();
  if (command === 'validate') {
    const record = validateCaseRecord(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')));
    process.stdout.write(JSON.stringify(record) + '\n');
    return;
  }
  if (command === 'record-path') {
    process.stdout.write(recordPath(JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))) + '\n');
    return;
  }
  if (command === 'attest') {
    const record = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const event = JSON.parse(fs.readFileSync(process.argv[4] || process.env.GITHUB_EVENT_PATH, 'utf8'));
    await attestCaseRecord(record, {
      event, repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    });
    process.stdout.write(recordPath(record) + '\\n');
    return;
  }
  if (command === 'enrich') {
    const input = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const output = process.argv[4];
    const event = JSON.parse(fs.readFileSync(process.argv[7] || process.env.GITHUB_EVENT_PATH, 'utf8'));
    const { source } = await attestCaseRecord(input, {
      event, repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    });
    const enriched = enrichCaseRecord(input, {
      workflowUrl: process.argv[5],
      recordPath: process.argv[6],
      source,
    });
    fs.writeFileSync(output, JSON.stringify(enriched, null, 2) + '\n');
    return;
  }
  if (command === 'apply') {
    const record = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const result = await applyCaseRecord(record, {
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  throw new Error('usage: node scripts/acceptance-case-ingest.mjs <self-test|validate FILE|attest FILE EVENT|record-path FILE|enrich IN OUT WORKFLOW_URL RECORD_PATH EVENT|apply FILE>');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
