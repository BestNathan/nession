#!/usr/bin/env node
// #1876: trusted main Quality producer preflight for a distinct Web-dist
// consumer. This only authenticates SOURCE provenance; it never confers
// Acceptance/SC Pass. All API reads occur before executing source SHA code.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';

const REPO = 'BestNathan/nession';
const WORKFLOW = '.github/workflows/ci-quality.yml';
const SHA = /^[a-f0-9]{40}$/;
const positive = x => Number.isSafeInteger(x) && x > 0;
const requiredSteps = ['Verify repository tooling Gates', 'Verify Web and design Gates',
  'Verify negative fixtures and Acceptance harness contracts',
  'Verify Web artifact integrity and negative fixtures',
  'Build verified main Web dist', 'Pack exact-SHA Web dist',
  'Publish exact-SHA Web dist transport'];

export function verify(event, run, jobs) {
  const source = event?.workflow_run;
  assert.equal(event?.repository?.full_name, REPO, 'foreign event repository');
  assert.ok(positive(source?.id) && positive(source?.run_attempt), 'invalid event run identity');
  assert.ok(SHA.test(source?.head_sha ?? ''), 'invalid event target SHA');
  assert.equal(source?.id, run?.id, 'event producer run mismatch');
  assert.equal(source?.run_attempt, run?.run_attempt, 'event producer attempt mismatch');
  assert.equal(source?.head_sha, run?.head_sha, 'event SHA mismatch');
  assert.equal(source?.event, 'push', 'only main-push producer is eligible');
  assert.equal(run?.event, 'push', 'only main-push producer is eligible');
  assert.equal(source?.head_branch, 'main', 'producer was not main');
  assert.equal(run?.head_branch, 'main', 'producer was not main');
  assert.equal(source?.name, 'CI / Quality Gate', 'wrong producer workflow');
  assert.equal(run?.name, 'CI / Quality Gate', 'wrong producer workflow');
  assert.equal(run?.path, WORKFLOW, 'wrong producer path');
  assert.equal(run?.repository?.full_name, REPO, 'wrong run repository');
  assert.equal(run?.head_repository?.full_name, REPO, 'foreign head repository');
  assert.equal(source?.conclusion, 'success', 'producer was not successful');
  assert.equal(run?.conclusion, 'success', 'producer was not successful');
  assert.equal(run?.status, 'completed', 'producer not completed');
  assert.ok(Array.isArray(jobs?.jobs) && jobs?.total_count <= 100, 'incomplete job enumeration');
  const web = jobs.jobs.filter(job => job?.name === 'web-check');
  assert.equal(web.length, 1, 'missing or duplicate web producer job');
  assert.equal(web[0]?.run_id, run.id, 'web-check run provenance mismatch');
  assert.equal(web[0]?.run_attempt, run.run_attempt, 'web-check attempt mismatch');
  assert.equal(web[0]?.head_sha, run.head_sha, 'web-check SHA mismatch');
  assert.equal(web[0]?.conclusion, 'success', 'web-check was not successful');
  assert.equal(web[0]?.status, 'completed', 'web-check not completed');
  for (const name of requiredSteps) {
    const matching = web[0]?.steps?.filter(s => s.name === name) ?? [];
    assert.equal(matching.length, 1, 'missing or duplicate producer step: ' + name);
    assert.equal(matching[0].conclusion, 'success', 'producer step incomplete: ' + name);
  }
  return {
    schema_version: 1, kind: 'attested_web_dist_source', sha: run.head_sha,
    run_id: run.id, run_attempt: run.run_attempt, job_id: web[0].id,
  };
}

function api(route) {
  return JSON.parse(execFileSync('gh', ['api', 'repos/' + REPO + route], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 3 * 1024 * 1024,
  }));
}

function selfTest() {
  const sha = 'a'.repeat(40);
  const run = {
    id: 21, run_attempt: 2, head_sha: sha, event: 'push', head_branch: 'main',
    name: 'CI / Quality Gate', path: WORKFLOW, status: 'completed', conclusion: 'success',
    repository: { full_name: REPO }, head_repository: { full_name: REPO },
  };
  const event = {
    repository: { full_name: REPO },
    workflow_run: { id: run.id, run_attempt: run.run_attempt, head_sha: sha,
      event: 'push', head_branch: 'main', name: run.name, conclusion: 'success' },
  };
  const jobs = { total_count: 1, jobs: [{ id: 41, name: 'web-check', run_id: run.id,
    run_attempt: 2, head_sha: sha, conclusion: 'success', status: 'completed',
    steps: requiredSteps.map(name => ({ name, conclusion: 'success' })) }] };
  assert.equal(verify(event, run, jobs).sha, sha);
  for (const [e, r, j] of [
    [{ ...event, repository: { full_name: 'other/repo' } }, run, jobs],
    [event, { ...run, event: 'pull_request' }, jobs],
    [event, { ...run, head_branch: 'feature' }, jobs],
    [event, { ...run, head_sha: 'b'.repeat(40) }, jobs],
    [event, { ...run, conclusion: 'failure' }, jobs],
    [event, { ...run, path: '.github/workflows/fake.yml' }, jobs],
    [event, run, { ...jobs, jobs: [{ ...jobs.jobs[0], conclusion: 'failure' }] }],
    [event, run, { ...jobs, jobs: [{ ...jobs.jobs[0], steps: jobs.jobs[0].steps.slice(1) }] }],
    [event, run, { ...jobs, jobs: [{ ...jobs.jobs[0], run_attempt: 3 }] }],
    [event, run, { ...jobs, jobs: [{ ...jobs.jobs[0], steps: [...jobs.jobs[0].steps, jobs.jobs[0].steps[0]] }] }],
  ]) assert.throws(() => verify(e, r, j));
  console.log('web dist source attestation: 10 fail-closed mutations passed');
}

const mode = process.argv[2];
if (mode === 'self-test') selfTest();
else if (mode === 'attest') {
  const eventPath = process.argv[3], outputPath = process.argv[4];
  if (!eventPath || !outputPath) throw Error('attest EVENT_JSON GITHUB_OUTPUT');
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const id = event?.workflow_run?.id;
  if (!positive(id)) throw Error('invalid workflow_run source');
  const receipt = verify(event,
    api('/actions/runs/' + id),
    api('/actions/runs/' + id + '/jobs?per_page=100'));
  appendFileSync(outputPath, 'sha=' + receipt.sha + '\nrun_id=' + receipt.run_id +
    '\nattempt=' + receipt.run_attempt + '\n');
  console.log('WEB_DIST_SOURCE_V1 ' + JSON.stringify(receipt));
} else { console.error('usage: web-dist-source-attestation.mjs self-test | attest EVENT GITHUB_OUTPUT'); process.exitCode = 2; }
