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
const requiredSteps = {
  'scope': ['Classify the exact PR or main-push change'],
  'web-check': ['Enforce applicable Quality results at the stable check name'],
  'web-tests': ['Verify Web and design Gates',
    'Verify negative fixtures and Acceptance harness contracts',
    'Verify Web artifact integrity and negative fixtures'],
  'web-dist': ['Build verified main Web dist', 'Pack exact-SHA Web dist',
    'Publish exact-SHA Web dist transport'],
  'tooling-check': ['Verify repository tooling Gates'],
};

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
  function verifyJob(name, required, optional = false) {
    const matched = jobs.jobs.filter(job => job?.name === name);
    assert.equal(matched.length, 1, 'missing or duplicate producer job: ' + name);
    const job = matched[0];
    assert.equal(job?.run_id, run.id, name + ' run provenance mismatch');
    assert.equal(job?.run_attempt, run.run_attempt, name + ' attempt mismatch');
    assert.equal(job?.head_sha, run.head_sha, name + ' SHA mismatch');
    assert.equal(job?.status, 'completed', name + ' not completed');
    if (optional && job?.conclusion === 'skipped') return job;
    assert.equal(job?.conclusion, 'success', name + ' was not successful');
    for (const step of required) {
      const matches = job?.steps?.filter(s => s.name === step) ?? [];
      assert.equal(matches.length, 1, 'missing or duplicate ' + name + ' step: ' + step);
      assert.equal(matches[0].conclusion, 'success', name + ' step incomplete: ' + step);
    }
    return job;
  }
  verifyJob('scope', requiredSteps.scope);
  verifyJob('web-check', requiredSteps['web-check']);
  verifyJob('web-tests', requiredSteps['web-tests']);
  // Tooling may be inapplicable on Web-only main pushes; the successful
  // web-check aggregate authenticates either the successful suite or this skip.
  verifyJob('tooling-check', requiredSteps['tooling-check'], true);
  const dist = verifyJob('web-dist', requiredSteps['web-dist']);
  return {
    schema_version: 1, kind: 'attested_web_dist_source', sha: run.head_sha,
    run_id: run.id, run_attempt: run.run_attempt, job_id: dist.id,
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
  const event = { repository: { full_name: REPO }, workflow_run: {
    id: run.id, run_attempt: run.run_attempt, head_sha: sha, event: 'push',
    head_branch: 'main', name: run.name, conclusion: 'success',
  }};
  const jobs = { total_count: 5, jobs: Object.entries(requiredSteps).map(([name, steps], i) => ({
    id: 40+i, name, run_id: run.id, run_attempt: 2, head_sha: sha,
    conclusion: 'success', status: 'completed',
    steps: steps.map(step => ({name:step, conclusion:'success'})),
  })) };
  assert.equal(verify(event, run, jobs).job_id, 43);
  const mutate = (name, fn) => {
    const altered = { ...jobs, jobs: jobs.jobs.map(job => job.name===name ? fn(job) : job) };
    assert.throws(() => verify(event,run,altered), name+' negative mutation must fail');
  };
  for (const name of Object.keys(requiredSteps)) {
    mutate(name, j => ({...j,conclusion:'failure'}));
    mutate(name, j => ({...j,head_sha:'b'.repeat(40)}));
    mutate(name, j => ({...j,run_attempt:3}));
    mutate(name, j => ({...j,steps:j.steps.slice(1)}));
    mutate(name, j => ({...j,steps:[...j.steps,j.steps[0]]}));
    const missing = {...jobs,jobs:jobs.jobs.filter(j=>j.name!==name)};
    assert.throws(()=>verify(event,run,missing),'missing '+name+' cannot Pass');
  }
  assert.equal(verify(event,run,{...jobs,jobs:jobs.jobs.map(j=>
    j.name==='tooling-check'? {...j,conclusion:'skipped',steps:[]} : j)}).sha,sha);
  for (const [e, r] of [
    [{...event,repository:{full_name:'other/repo'}},run],
    [event,{...run,event:'pull_request'}],
    [event,{...run,head_branch:'feature'}],
    [event,{...run,head_sha:'b'.repeat(40)}],
    [event,{...run,conclusion:'failure'}],
    [event,{...run,path:'.github/workflows/fake.yml'}],
  ])assert.throws(()=>verify(e,r,jobs));
  console.log('web dist source attestation: separate aggregate/Web/Tooling/artifact jobs and fail-closed provenance fixtures passed');
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
