#!/usr/bin/env node
// Trusted #1900 PR Issue-E2E artifact lookup.
// GitHub lists artifacts for the whole RUN, not the specific RUN ATTEMPT.
// After a rerun a failed attempt's "issue-e2e-verification" ZIP remains in
// that collection. Select only the unique artifact created within the exact
// completed E2E producer Job's authenticated attempt/time interval.
// This is a locator, not an Acceptance verdict: the existing independent
// issue-e2e-source-attestation.mjs still authenticates plan/results/assertions.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const REPO = 'BestNathan/nession';
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
const when = s => {
  const t = Date.parse(s ?? '');
  assert.ok(Number.isFinite(t), 'missing or invalid GitHub timestamp');
  return t;
};

export function selectExactAttemptIssueArtifact(run, jobs, artifacts) {
  assert.ok(positive(run?.id) && positive(run?.run_attempt));
  assert.match(run?.head_sha ?? '', SHA);
  assert.equal(run?.repository?.full_name, REPO);
  assert.equal(run?.event, 'pull_request');
  assert.equal(run?.path, '.github/workflows/e2e-tests.yml');
  assert.equal(run?.status, 'completed');
  assert.ok(['success', 'failure'].includes(run?.conclusion), 'not a settled E2E source');
  assert.ok(Array.isArray(jobs?.jobs) && positive(jobs?.total_count) &&
    jobs.total_count <= 100 && jobs.jobs.length === jobs.total_count,
    'truncated or ambiguous source Attempt job enumeration');
  const matchingJobs = jobs.jobs.filter(j => j.name === 'e2e' &&
    j.run_id === run.id && j.run_attempt === run.run_attempt &&
    j.head_sha === run.head_sha);
  assert.equal(matchingJobs.length, 1, 'missing/duplicate exact Attempt E2E job');
  const job = matchingJobs[0];
  assert.ok(positive(job.id) && job.status === 'completed' &&
    job.conclusion === run.conclusion, 'job outcome differs from source Run');
  const begin = when(job.started_at), end = when(job.completed_at);
  assert.ok(end >= begin && begin >= when(run.created_at), 'invalid source Job time interval');
  assert.ok(Array.isArray(artifacts?.artifacts) &&
    Number.isSafeInteger(artifacts?.total_count) &&
    artifacts.total_count <= 100 && artifacts.artifacts.length === artifacts.total_count,
    'truncated source artifact enumeration');
  const matching = artifacts.artifacts.filter(a =>
    a.name === 'issue-e2e-verification' && !a.expired &&
    Number.isFinite(Date.parse(a.created_at ?? '')) &&
    Date.parse(a.created_at) >= begin && Date.parse(a.created_at) <= end);
  assert.equal(matching.length, 1,
    'missing or duplicate exact-Attempt Issue E2E verification artifact');
  const artifact = matching[0];
  assert.ok(positive(artifact.id) && positive(artifact.size_in_bytes) &&
    artifact.size_in_bytes <= 1024 * 1024 * 1024);
  assert.match(artifact.digest ?? '', DIGEST, 'missing artifact SHA256');
  assert.equal(artifact.workflow_run?.id, run.id, 'foreign Run artifact');
  assert.equal(artifact.workflow_run?.head_sha, run.head_sha, 'foreign SHA artifact');
  assert.ok(when(artifact.expires_at) > when(artifact.created_at),
    'expired or invalid artifact lifetime');
  return artifact;
}

function selfTest() {
  const sha = 'a'.repeat(40), run = {
    id: 200, run_attempt: 2, head_sha: sha, status: 'completed',
    conclusion: 'success', event: 'pull_request',
    path: '.github/workflows/e2e-tests.yml',
    repository: { full_name: REPO },
    created_at: '2026-10-18T02:00:00Z',
  };
  const job = { id: 21, name: 'e2e', run_id: 200, run_attempt: 2,
    head_sha: sha, status: 'completed', conclusion: 'success',
    started_at: '2026-10-18T02:20:00Z',
    completed_at: '2026-10-18T02:25:00Z' };
  const jobs = { total_count: 1, jobs: [job] };
  const artifact = { id: 32, name: 'issue-e2e-verification',
    size_in_bytes: 40000, expired: false, digest: 'sha256:' + 'b'.repeat(64),
    created_at: '2026-10-18T02:24:00Z',
    expires_at: '2026-10-31T00:00:00Z',
    workflow_run: { id: 200, head_sha: sha } };
  const old = { ...artifact, id: 31, created_at: '2026-10-18T02:10:00Z' };
  const arts = { total_count: 2, artifacts: [old, artifact] };
  assert.equal(selectExactAttemptIssueArtifact(run, jobs, arts).id, 32);
  assert.equal(selectExactAttemptIssueArtifact(run, jobs,
    { ...arts, artifacts: [artifact, old] }).id, 32);
  assert.equal(selectExactAttemptIssueArtifact(run, jobs,
    { total_count: 1, artifacts: [artifact] }).id, 32);
  const bad = [
    [{ ...run, run_attempt: 1 }, jobs, arts],
    [{ ...run, head_sha: 'c'.repeat(40) }, jobs, arts],
    [{ ...run, conclusion: 'failure' }, jobs, arts],
    [run, { total_count: 1, jobs: [{ ...job, run_attempt: 1 }] }, arts],
    [run, { total_count: 1, jobs: [{ ...job, completed_at: job.started_at }] }, arts],
    [run, jobs, { total_count: 1, artifacts: [old] }],
    [run, jobs, { total_count: 3, artifacts: [old, artifact, { ...artifact, id: 33 }] }],
    [run, jobs, { total_count: 2, artifacts: [old, { ...artifact, digest: '' }] }],
    [run, jobs, { total_count: 2, artifacts: [old, { ...artifact, workflow_run: { id: 201, head_sha: sha } }] }],
    [run, jobs, { total_count: 2, artifacts: [old, { ...artifact, workflow_run: { id: 200, head_sha: 'c'.repeat(40) } }] }],
    [run, { total_count: 101, jobs: [job] }, arts],
    [run, jobs, { total_count: 3, artifacts: [old, artifact] }],
  ];
  for (const args of bad) {
    assert.throws(() => selectExactAttemptIssueArtifact(...args),
      'attempt or artifact mutation unexpectedly accepted');
  }
  console.log('PR Issue-E2E artifact selector: stale attempt tolerated, 12 fail-closed negatives pass');
}

if (process.argv[1]?.endsWith('issue-e2e-attempt-artifact.mjs')) {
  const [cmd, runPath, jobsPath, artifactsPath, outputPath] = process.argv.slice(2);
  if (cmd === 'self-test') selfTest();
  else if (cmd === 'select') {
    assert.ok(runPath && jobsPath && artifactsPath && outputPath,
      'select RUN JOBS ARTIFACTS OUTPUT required');
    const result = selectExactAttemptIssueArtifact(
      JSON.parse(fs.readFileSync(runPath,'utf8')),
      JSON.parse(fs.readFileSync(jobsPath,'utf8')),
      JSON.parse(fs.readFileSync(artifactsPath,'utf8')),
    );
    fs.writeFileSync(outputPath, JSON.stringify(result) + '\n', {flag:'wx'});
    console.log('Selected authenticated source artifact ID '+result.id);
  } else throw Error('usage: self-test | select RUN JOBS ARTIFACTS OUTPUT');
}
