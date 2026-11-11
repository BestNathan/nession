#!/usr/bin/env node
// Owner: #3072. Authenticate the original native Staging release before
// a workflow_run-triggered read-only deployment observer may use cluster
// secrets. The attestation/Store/SC writers remain separate trusted owners.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const REPO = 'BestNathan/nession';
const NAME = 'Release / Staging Artifacts';
const PATH = '.github/workflows/release-staging.yml';
const SHA = /^[a-f0-9]{40}$/;

function reject(reason) { throw Error('deployment-identity-trigger: ' + reason); }
function positive(n) { return Number.isSafeInteger(n) && n > 0; }

export function verifyReleaseSource(event, nativeJobs, originalRun = null) {
  const run = event?.workflow_run;
  if (!run || event?.action !== 'completed' ||
      event.repository?.full_name !== REPO ||
      run.name !== NAME || String(run.path ?? '').split('@')[0] !== PATH ||
      !['push', 'workflow_dispatch'].includes(run.event) ||
      run.head_branch !== 'staging' || !SHA.test(String(run.head_sha ?? '')) ||
      run.status !== 'completed' || run.conclusion !== 'success' ||
      run.repository?.full_name !== REPO ||
      run.head_repository?.full_name !== REPO ||
      !positive(run.id) || !positive(run.run_attempt) ||
      !positive(run.workflow_id)) reject('invalid native Staging release source identity');
  if (originalRun && (
      originalRun.id !== run.id ||
      originalRun.run_attempt !== run.run_attempt ||
      originalRun.head_sha !== run.head_sha ||
      originalRun.path !== run.path ||
      originalRun.event !== run.event ||
      originalRun.conclusion !== 'success' ||
      originalRun.repository?.full_name !== REPO ||
      originalRun.head_repository?.full_name !== REPO)) {
    reject('source event and native original Run disagree');
  }
  const jobs = Array.isArray(nativeJobs?.jobs) ? nativeJobs.jobs : null;
  if (!jobs || jobs.length === 0 || jobs.length >= 100 ||
      (nativeJobs.total_count != null && nativeJobs.total_count !== jobs.length)) {
    reject('missing, truncated or ambiguous original release jobs');
  }
  for (const [name, step] of [
    ['deploy-staging-gitops', /^Run \.\/scripts\/gitops-commit\.sh staging/],
    ['provenance', /^Emit per-registry build provenance$/],
  ]) {
    const selected = jobs.filter(j => j.name === name &&
      j.run_id === run.id && j.run_attempt === run.run_attempt);
    if (selected.length !== 1 || selected[0].status !== 'completed' ||
        selected[0].conclusion !== 'success') reject('missing successful original release job ' + name);
    const matched = (selected[0].steps ?? []).filter(s => step.test(String(s.name)) &&
      s.status === 'completed' && s.conclusion === 'success');
    if (matched.length !== 1) reject('missing successful release step in ' + name);
  }
  return Object.freeze({
    source_run_id: run.id,
    source_run_attempt: run.run_attempt,
    source_sha: run.head_sha,
    environment_id: 'staging',
  });
}

export function selfTest() {
  const sha = 'a'.repeat(40);
  const run = {
    id: 4200, run_attempt: 1, workflow_id: 33,
    name: NAME, path: PATH, event: 'push', head_branch: 'staging',
    head_sha: sha, status: 'completed', conclusion: 'success',
    repository: { full_name: REPO }, head_repository: { full_name: REPO },
  };
  const event = { action: 'completed', repository: { full_name: REPO }, workflow_run: run };
  const ok = name => ({
    name, run_id: run.id, run_attempt: 1, status: 'completed',
    conclusion: 'success', steps: [
      { name: name === 'provenance' ? 'Emit per-registry build provenance' :
        'Run ./scripts/gitops-commit.sh staging "abc"', status: 'completed',
        conclusion: 'success' },
    ],
  });
  const jobs = { total_count: 2, jobs: [
    ok('deploy-staging-gitops'), ok('provenance'),
  ] };
  assert.equal(verifyReleaseSource(event, jobs, run).source_sha, sha);
  assert.equal(verifyReleaseSource({
    ...event, workflow_run: { ...run, event: 'workflow_dispatch' },
  }, jobs).source_sha, sha);
  for (const bad of [
    { name: 'Unrelated' }, { path: '.github/workflows/foreign.yml' },
    { event: 'pull_request' }, { head_branch: 'main' },
    { head_sha: 'b'.repeat(40) }, { conclusion: 'failure' },
    { status: 'in_progress' }, { run_attempt: 2 },
    { repository: { full_name: 'attacker/nession' } },
    { head_repository: { full_name: 'attacker/nession' } },
  ]) assert.throws(() => verifyReleaseSource({
    ...event, workflow_run: { ...run, ...bad },
  }, jobs, run), /invalid native Staging|native original Run disagree/);
  assert.throws(() => verifyReleaseSource({
    ...event, repository: { full_name: 'attacker/nession' },
  }, jobs), /invalid native/);
  assert.throws(() => verifyReleaseSource({ ...event, action: 'requested' }, jobs),
    /invalid native/);
  assert.throws(() => verifyReleaseSource(event, {
    total_count: 1, jobs: [jobs.jobs[0]],
  }), /missing successful original release job/);
  assert.throws(() => verifyReleaseSource(event, {
    total_count: 2, jobs: [{ ...jobs.jobs[0], conclusion: 'skipped' }, jobs.jobs[1]],
  }), /missing successful original release job/);
  assert.throws(() => verifyReleaseSource(event, {
    total_count: 2, jobs: [
      { ...jobs.jobs[0], steps: [{ ...jobs.jobs[0].steps[0], conclusion: 'skipped' }] },
      jobs.jobs[1],
    ],
  }), /missing successful release step/);
  assert.throws(() => verifyReleaseSource(event, {
    total_count: 3, jobs: jobs.jobs,
  }), /missing, truncated or ambiguous/);
  assert.throws(() => verifyReleaseSource(event, jobs, {
    ...run, head_sha: 'b'.repeat(40),
  }), /source event and native original Run disagree/);
  console.log('deployment identity trigger: exact native release run/attempt, GitOps and provenance step fixtures passed');
}

async function main() {
  const command = process.argv[2];
  if (command === 'self-test') { selfTest(); return; }
  if (command !== 'verify' || !process.argv[3]) reject('usage: self-test | verify EVENT_JSON');
  const event = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const runId = event?.workflow_run?.id;
  const attempt = event?.workflow_run?.run_attempt;
  if (!positive(runId) || !positive(attempt)) reject('no original native run identity');
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) reject('GitHub read token unavailable');
  async function api(route) {
    const response = await fetch('https://api.github.com/repos/' + REPO + route, {
      headers: { Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nession-deployment-identity-trigger' },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) reject('native GitHub source unavailable: HTTP ' + response.status);
    return response.json();
  }
  const [run, jobs] = await Promise.all([
    api('/actions/runs/' + runId),
    api('/actions/runs/' + runId + '/attempts/' + attempt + '/jobs?per_page=100'),
  ]);
  const verified = verifyReleaseSource(event, jobs, run);
  console.log('TRUSTED_STAGING_RELEASE_V1 ' + JSON.stringify(verified));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    'Original trusted Staging release observed: ' + verified.source_run_id +
    '/' + verified.source_run_attempt + ' @ ' + verified.source_sha + '\n');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
