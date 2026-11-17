#!/usr/bin/env node
// #3674: read-only exact-SHA proof that GHCR images were published by CI.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const REPO = 'BestNathan/nession';
const PATH = '.github/workflows/release-staging.yml';
const SHA = /^[a-f0-9]{40}$/;
const JOBS = [
  'docker-server-amd64', 'docker-agent-amd64', 'docker-mcp-amd64', 'docker-ui-amd64',
  'docker-server-arm64', 'docker-agent-arm64', 'docker-mcp-arm64', 'docker-ui-arm64',
  'merge', 'provenance',
];
function deny(message) { throw Error('staging GHCR source: ' + message); }

export function verifyRelease(run, inventory, expectedSha) {
  if (!SHA.test(expectedSha) || run?.head_sha !== expectedSha ||
      run?.path?.split('@')[0] !== PATH ||
      run?.name !== 'Release / Staging Artifacts' ||
      !['push', 'workflow_dispatch'].includes(run?.event) ||
      run?.head_branch !== 'staging' ||
      run?.repository?.full_name !== REPO ||
      run?.head_repository?.full_name !== REPO ||
      run?.status !== 'completed' || run?.conclusion !== 'success' ||
      !Number.isSafeInteger(run?.id) || run.id <= 0 ||
      !Number.isSafeInteger(run?.run_attempt) || run.run_attempt <= 0) {
    deny('invalid source workflow/branch/repo/SHA/attempt/result');
  }
  const jobs = inventory?.jobs;
  if (!Array.isArray(jobs) || jobs.length < JOBS.length || jobs.length >= 100 ||
      (inventory.total_count != null && inventory.total_count !== jobs.length)) {
    deny('missing or truncated source jobs');
  }
  for (const name of JOBS) {
    const found = jobs.filter(job => job.name === name &&
      job.run_id === run.id &&
      (job.run_attempt == null || job.run_attempt === run.run_attempt));
    if (found.length !== 1 || found[0].status !== 'completed' ||
        found[0].conclusion !== 'success') {
      deny('missing successful original job ' + name);
    }
  }
  for (const [name, step] of [
    ['merge', 'Create multi-arch hash manifests'],
    ['provenance', 'Emit GHCR build provenance'],
  ]) {
    const selected = jobs.find(job => job.name === name);
    const passed = (selected?.steps ?? []).filter(entry => entry.name === step &&
      entry.status === 'completed' && entry.conclusion === 'success');
    if (passed.length !== 1) deny('missing successful original step ' + name);
  }
  return Object.freeze({source_sha: expectedSha,
    short_sha: expectedSha.slice(0, 7),
    source_run_id: run.id, source_run_attempt: run.run_attempt});
}

export function selfTest() {
  const sha = 'a'.repeat(40);
  const run = {id: 79, run_attempt: 1, name: 'Release / Staging Artifacts',
    path: PATH, event: 'push', head_branch: 'staging', head_sha: sha,
    status: 'completed', conclusion: 'success',
    repository: {full_name: REPO}, head_repository: {full_name: REPO}};
  const jobs = JOBS.map(name => ({name, run_id: 79, run_attempt: 1,
    status: 'completed', conclusion: 'success', steps: [
      {name: name === 'merge' ? 'Create multi-arch hash manifests' :
        name === 'provenance' ? 'Emit GHCR build provenance' : 'Build published image',
      status: 'completed', conclusion: 'success'},
    ]}));
  const inventory = {jobs, total_count: jobs.length};
  assert.equal(verifyRelease(run, inventory, sha).short_sha, 'aaaaaaa');
  for (const bad of [
    {head_sha: 'b'.repeat(40)}, {head_branch: 'main'},
    {path: '.github/workflows/foreign.yml'}, {name: 'Forgery'},
    {event: 'pull_request'}, {conclusion: 'failure'}, {status: 'in_progress'},
    {run_attempt: 2}, {repository: {full_name: 'other/nession'}},
    {head_repository: {full_name: 'other/nession'}},
  ]) {
    assert.throws(() => verifyRelease({...run, ...bad}, inventory, sha));
  }
  for (const name of JOBS) {
    assert.throws(() => verifyRelease(run, {...inventory, jobs: jobs.map(job =>
      job.name === name ? {...job, conclusion: 'failure'} : job)}, sha));
  }
  assert.throws(() => verifyRelease(run, {jobs: jobs.slice(1), total_count: 9}, sha));
  assert.throws(() => verifyRelease(run, {...inventory, jobs: jobs.map(job =>
    job.name === 'merge' ? {...job, steps: []} : job)}, sha));
  console.log('Staging GHCR source identity, ten jobs and negative fixtures passed');
}

async function main() {
  const command = process.argv[2];
  if (command === 'self-test') { selfTest(); return; }
  const sourceSha = process.argv[3];
  // A manual main-owned diagnostic can inspect a historical, authenticated
  // Staging release but may not deploy it or claim a current Staging identity.
  const staged = command === 'wait';
  const diagnostic = command === 'verify-mirror';
  const trustedContext = staged
    ? process.env.GITHUB_REF === 'refs/heads/staging' &&
      process.env.GITHUB_SHA === sourceSha
    : diagnostic && process.env.GITHUB_REF === 'refs/heads/main' &&
      process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  if ((!staged && !diagnostic) || !SHA.test(sourceSha) ||
      process.env.GITHUB_REPOSITORY !== REPO || !trustedContext ||
      !process.env.GH_TOKEN || !process.env.GITHUB_OUTPUT) {
    deny('invalid trusted execution or usage: self-test | wait <full-sha> | verify-mirror <full-sha>');
  }
  const api = async route => {
    const response = await fetch('https://api.github.com/repos/' + REPO + route, {
      headers: {Authorization: 'Bearer ' + process.env.GH_TOKEN,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nession-acr-source'},
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) deny('GitHub API failed: HTTP ' + response.status);
    return response.json();
  };
  // This independent job can wait while the GHCR-only build proceeds. A failed
  // or absent source cannot be laundered into a successful ACR/GitOps receipt.
  for (let attempt = 1; attempt <= (diagnostic ? 1 : 240); attempt++) {
    const body = await api('/actions/workflows/release-staging.yml/runs?head_sha=' +
      sourceSha + '&per_page=100');
    if (!Array.isArray(body.workflow_runs) || body.total_count > 100) {
      deny('unbounded GHCR release inventory');
    }
    const matching = body.workflow_runs.filter(run =>
      run.path?.split('@')[0] === PATH && run.head_sha === sourceSha &&
      run.head_branch === 'staging' &&
      run.repository?.full_name === REPO &&
      run.head_repository?.full_name === REPO &&
      ['push', 'workflow_dispatch'].includes(run.event));
    const selected = matching.sort((a, b) =>
      (b.run_number ?? 0) - (a.run_number ?? 0) ||
      (b.run_attempt ?? 0) - (a.run_attempt ?? 0) ||
      (b.id ?? 0) - (a.id ?? 0))[0];
    if (selected?.status === 'completed') {
      if (selected.conclusion !== 'success') {
        deny('latest GHCR source run failed: ' + selected.id +
          '; repair/re-run source before deploying');
      }
      const [run, jobs] = await Promise.all([
        api('/actions/runs/' + selected.id),
        api('/actions/runs/' + selected.id +
          '/attempts/' + selected.run_attempt + '/jobs?per_page=100'),
      ]);
      const verified = verifyRelease(run, jobs, sourceSha);
      if (staged) {
        const branch = await api('/branches/staging');
        if (branch.commit?.sha !== sourceSha) {
          deny('Staging moved to another SHA; refuse a stale rollout');
        }
      }
      fs.appendFileSync(process.env.GITHUB_OUTPUT,
        'source_sha=' + verified.source_sha + '\n' +
        'short_sha=' + verified.short_sha + '\n' +
        'source_run_id=' + verified.source_run_id + '\n' +
        'source_run_attempt=' + verified.source_run_attempt + '\n');
      console.log('TRUSTED_STAGING_GHCR_V1 ' + JSON.stringify(verified));
      return;
    }
    if (diagnostic) {
      deny('no completed authenticated Staging GHCR release for source SHA');
    }
    if (attempt % 8 === 1) {
      console.log('Waiting for GHCR release ' + sourceSha.slice(0, 7));
    }
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  deny('GHCR source did not complete within a 60-minute observation window');
}
main().catch(error => {console.error(error.stack || error); process.exitCode = 1;});
