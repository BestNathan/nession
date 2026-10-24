#!/usr/bin/env node
// Main-owned authenticated intake for scheduled Full Regression failures.
// This records observations only: it never dispatches an Agent or declares Pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = 'BestNathan/nession';
const WORKFLOW_PATH = '.github/workflows/e2e-full-regression.yml';
const WORKFLOW_NAME = 'E2E / Full Regression';
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const reject = message => { throw new Error('e2e full-failure ingest rejected: ' + message); };

function verify({ event, run, workflow, jobs, artifacts, candidate, archiveSha256 }) {
  assert.equal(event?.repository?.full_name, REPO);
  assert.equal(event?.workflow_run?.id, run?.id);
  assert.equal(event?.workflow_run?.run_attempt, run?.run_attempt);
  assert.equal(event?.workflow_run?.head_sha, run?.head_sha);
  assert.equal(run?.repository?.full_name, REPO);
  assert.equal(run?.head_repository?.full_name, REPO);
  assert.equal(run?.path, WORKFLOW_PATH);
  assert.equal(run?.name, WORKFLOW_NAME);
  assert.equal(workflow?.path, WORKFLOW_PATH);
  assert.equal(workflow?.name, WORKFLOW_NAME);
  assert.equal(workflow?.id, run?.workflow_id);
  assert.equal(run?.event, 'schedule', 'only scheduled Main runs are eligible in this first slice');
  assert.equal(run?.head_branch, 'main');
  assert.equal(run?.status, 'completed');
  assert.equal(run?.conclusion, 'failure');
  assert.ok(SHA40.test(run?.head_sha ?? ''));
  assert.ok(positive(run?.id) && positive(run?.run_attempt) && positive(run?.workflow_id));

  const matchingJobs = (jobs?.jobs ?? []).filter(j => j.name === 'full' &&
    j.run_id === run.id && j.run_attempt === run.run_attempt);
  assert.equal(matchingJobs.length, 1, 'exact Full Regression job/attempt required');
  const job = matchingJobs[0];
  assert.equal(job.status, 'completed');
  assert.equal(job.conclusion, 'failure');
  assert.equal(job.head_sha, run.head_sha);
  assert.ok(Date.parse(job.started_at) <= Date.parse(job.completed_at));

  const expectedName = `full-regression-${run.id}-${run.run_attempt}`;
  const matchingArtifacts = (artifacts?.artifacts ?? []).filter(a =>
    a.name === expectedName && a.expired === false && a.workflow_run?.id === run.id);
  assert.equal(matchingArtifacts.length, 1, 'exact non-expired run/attempt artifact required');
  const artifact = matchingArtifacts[0];
  assert.ok(positive(artifact.id) && positive(artifact.size_in_bytes));
  assert.ok(artifact.size_in_bytes <= 1024 * 1024 * 1024, 'artifact exceeds size limit');
  assert.match(artifact.digest ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.equal(artifact.workflow_run?.head_sha, run.head_sha);
  const created = Date.parse(artifact.created_at);
  assert.ok(created >= Date.parse(job.started_at) && created <= Date.parse(job.completed_at),
    'artifact must be created during exact failed attempt');
  assert.equal(archiveSha256, artifact.digest.slice(7), 'downloaded artifact bytes do not match GitHub digest');

  assert.equal(candidate?.schema_version, 1);
  assert.equal(candidate?.kind, 'e2e_full_failure_candidate');
  assert.equal(candidate?.provenance, 'UNATTESTED_ARTIFACT_ONLY');
  assert.equal(candidate?.run_id, run.id);
  assert.equal(candidate?.run_attempt, run.run_attempt);
  assert.equal(candidate?.target_sha, run.head_sha, 'candidate target is not the scheduled source SHA');
  assert.ok(['FAILED_TESTS_OBSERVED','UNCLASSIFIED_FAILURE','NON_PASS_OR_UNKNOWN_OBSERVED',
    'NO_FAILED_TESTS_OBSERVED_NOT_PASS','REPORT_UNAVAILABLE'].includes(candidate.status));
  assert.ok(Array.isArray(candidate.results) && candidate.results.length <= 64);
  const ids = new Set();
  for (const item of candidate.results) {
    assert.ok(item && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id ?? ''));
    assert.ok(!ids.has(item.id), 'duplicate E2E ID');
    ids.add(item.id);
    for (const k of ['total','failed','skipped','flaky','expected','other']) {
      assert.ok(Number.isSafeInteger(item[k]) && item[k] >= 0, 'invalid count: ' + k);
    }
    assert.equal(item.failed + item.skipped + item.flaky + item.expected + item.other, item.total);
  }
  const record = {
    schema_version: 1,
    kind: 'e2e_full_failure_observation',
    trust: 'authenticated_github_run_and_artifact_digest',
    evaluation: 'NOT_EVALUATED',
    agent_dispatch: 'NOT_AUTHORIZED',
    source: { repository: REPO, workflow_path: WORKFLOW_PATH, workflow_id: run.workflow_id,
      event: run.event, branch: run.head_branch, run_id: run.id, run_attempt: run.run_attempt,
      source_sha: run.head_sha, conclusion: run.conclusion, run_url: run.html_url },
    artifact: { id: artifact.id, name: artifact.name, digest: artifact.digest,
      size_bytes: artifact.size_in_bytes, expires_at: artifact.expires_at,
      retention: 'GitHub Actions artifact; time-limited' },
    candidate: {
      status: candidate.status,
      observed_tests: Number.isSafeInteger(candidate.observed_tests) ? candidate.observed_tests : null,
      unknown_files: Number.isSafeInteger(candidate.unknown_files) ? candidate.unknown_files : null,
      results: candidate.results,
    },
    evidence: { archive_sha256: archiveSha256, candidate_sha256: digest(JSON.stringify(candidate)) },
  };
  const recordPath = `runs/${run.head_sha}/full-regression/${run.id}-${run.run_attempt}.json`;
  const indexPath = `indexes/by-sha/${run.head_sha}/full-regression/${run.id}-${run.run_attempt}.json`;
  const index = { schema_version: 1, kind: 'e2e_full_failure_observation_index',
    source_sha: run.head_sha, run_id: run.id, run_attempt: run.run_attempt,
    record_path: recordPath, record_sha256: digest(JSON.stringify(record, null, 2) + '\n') };
  return { record, index, record_path: recordPath, index_path: indexPath };
}
function selfTest() {
  const sha = 'a'.repeat(40), d = 'b'.repeat(64);
  const run = { id: 501, run_attempt: 2, workflow_id: 9, path: WORKFLOW_PATH, name: WORKFLOW_NAME,
    event: 'schedule', head_branch: 'main', head_sha: sha, status: 'completed', conclusion: 'failure',
    repository: { full_name: REPO }, head_repository: { full_name: REPO }, html_url: 'https://example.invalid/run/501' };
  const job = { name: 'full', run_id: 501, run_attempt: 2, head_sha: sha, status: 'completed',
    conclusion: 'failure', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:02:00Z' };
  const artifact = { id: 7, name: 'full-regression-501-2', expired: false, size_in_bytes: 100,
    digest: 'sha256:' + d, created_at: '2026-01-01T00:01:00Z', expires_at: '2026-01-15T00:00:00Z',
    workflow_run: { id: 501, head_sha: sha } };
  const candidate = { schema_version: 1, kind: 'e2e_full_failure_candidate',
    provenance: 'UNATTESTED_ARTIFACT_ONLY', run_id: 501, run_attempt: 2, target_sha: sha,
    status: 'FAILED_TESTS_OBSERVED', results: [{ id: 'terminal-attach', total: 2,
      failed: 1, skipped: 0, flaky: 0, expected: 1, other: 0 }] };
  const input = { event: { repository: { full_name: REPO }, workflow_run: { id: 501,
    run_attempt: 2, head_sha: sha } }, run, workflow: { id: 9, path: WORKFLOW_PATH, name: WORKFLOW_NAME },
    jobs: { jobs: [job] }, artifacts: { artifacts: [artifact] }, candidate, archiveSha256: d };
  const result = verify(input);
  assert.equal(result.record.agent_dispatch, 'NOT_AUTHORIZED');
  assert.match(result.record_path, new RegExp(sha));
  for (const bad of [
    { ...input, run: { ...run, event: 'workflow_dispatch' } },
    { ...input, run: { ...run, head_sha: 'c'.repeat(40) } },
    { ...input, archiveSha256: '0'.repeat(64) },
    { ...input, artifacts: { artifacts: [{ ...artifact, workflow_run: { id: 999, head_sha: sha } }] } },
    { ...input, candidate: { ...candidate, target_sha: 'c'.repeat(40) } },
    { ...input, candidate: { ...candidate, results: [candidate.results[0], candidate.results[0]] } },
  ]) assert.throws(() => verify(bad));
  console.log('e2e-full-failure-ingest self-test: PASS');
}
function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'self-test') return selfTest();
  if (command === 'verify-json' && args.length === 2) {
    const input = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    const result = verify(input);
    fs.mkdirSync(args[1], { recursive: true });
    fs.writeFileSync(path.join(args[1], 'record.json'), JSON.stringify(result.record, null, 2) + '\n', { flag: 'wx' });
    fs.writeFileSync(path.join(args[1], 'index.json'), JSON.stringify(result.index, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ record: result.record_path, index: result.index_path }));
    return;
  }
  reject('usage: self-test | verify-json INPUT.json OUT_DIR');
}
try { main(); } catch (e) { console.error(e.stack ?? e); process.exitCode = 2; }
