'use strict';
// #3072 SC-02: independent, uncredentialed readback of a REAL source->Store->wake.
// Only a matching outstanding staging Agent SC AND its canonical Issue update
// can satisfy the complete SC; a healthy no-op wake is Pending, never Pass.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

const REPO = 'BestNathan/nession';
const ROOT = path.resolve(__dirname, '../../../../..');
const STAGING_SOURCE = 'd466197f3fece03c2e04a3c546fe9edd8a7c538c';
const ORIGINAL_RUN = 42805092603;
const INGEST_RUN = 42815588295;
const WAKER_RUN = 42815670151;
const RECORD = 'runs/2026-11-10/42805092603-1/deployment/staging.json';
const INDEX = 'indexes/by-sha/' + STAGING_SOURCE +
  '/deployment/42805092603-1-staging.json';

async function get(route) {
  assert.match(route, /^\/repos\/BestNathan\/nession\//);
  const response = await fetch('https://api.github.com' + route, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nession-case-3072-sc02',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error('native source unavailable: HTTP ' +
    response.status + ' for ' + route);
  return response.json();
}
const resource = route => '/repos/' + REPO + route;
async function native(runId) {
  const [run, jobs] = await Promise.all([
    get(resource('/actions/runs/' + runId)),
    get(resource('/actions/runs/' + runId + '/attempts/1/jobs?per_page=100')),
  ]);
  assert.equal(run.id, runId);
  assert.equal(run.run_attempt, 1);
  assert.equal(run.repository?.full_name, REPO);
  assert.equal(run.head_repository?.full_name, REPO);
  assert.ok(Array.isArray(jobs.jobs) && jobs.jobs.length < 100);
  return { run, jobs: jobs.jobs };
}
function job(jobs, name, conclusion) {
  const matches = jobs.filter(j => j.name === name && j.run_attempt === 1);
  assert.equal(matches.length, 1, 'missing/ambiguous real job ' + name);
  assert.equal(matches[0].conclusion, conclusion,
    'unexpected ' + name + ' conclusion');
  return matches[0];
}
function hasStep(j, name) {
  assert.ok(j.steps?.some(s => s.name === name &&
    s.status === 'completed' && s.conclusion === 'success'),
  'unverified native step: ' + name);
}
async function main() {
  const checkout = targetSha();
  const { parseContents, normalizedPath, verifySource } = await import(
    pathToFileURL(path.join(ROOT,
      'scripts/acceptance-staging-history-proof.mjs')).href);
  const { selfTestWake } = await import(
    pathToFileURL(path.join(ROOT,
      'scripts/acceptance-staging-deployment-wake.mjs')).href);
  // Reject malformed, duplicated and attacker-controlled source fixtures.
  await selfTestWake();

  const [original, ingest, waker, indexFile, recordFile] = await Promise.all([
    native(ORIGINAL_RUN), native(INGEST_RUN), native(WAKER_RUN),
    get(normalizedPath(INDEX)), get(normalizedPath(RECORD)),
  ]);
  const { run: ingestRun, jobs: ingestJobs } = ingest;
  assert.equal(ingestRun.name, 'Deploy / Identity Ingest');
  assert.equal(ingestRun.path.split('@')[0],
    '.github/workflows/deploy-identity-ingest.yml');
  assert.equal(ingestRun.head_branch, 'main');
  assert.ok(['push','workflow_run'].includes(ingestRun.event));
  assert.equal(ingestRun.status, 'completed');
  assert.equal(ingestRun.conclusion, 'success');
  const ingestJob = job(ingestJobs, 'ingest', 'success');
  for (const step of [
    'Append compact immutable records and SHA indexes',
    'Verify immutable Git bytes before uploading Run Store receipts',
    'Emit source-aligned Staging Acceptance wake',
  ]) hasStep(ingestJob, step);

  const index = parseContents(indexFile, INDEX);
  const record = parseContents(recordFile, RECORD);
  assert.equal(index.target_sha, STAGING_SOURCE);
  assert.equal(index.record, RECORD);
  assert.equal(index.source?.run_id, ORIGINAL_RUN);
  assert.equal(index.source?.run_attempt, 1);
  const attested = verifySource(record, index, original.run, { jobs: original.jobs });
  assert.equal(attested.source_sha, STAGING_SOURCE);
  assert.equal(attested.source_run_id, ORIGINAL_RUN);
  assert.equal(attested.environment_id, 'staging');

  const { run: wakerRun, jobs: wakerJobs } = waker;
  assert.equal(wakerRun.name, 'Acceptance / Post-Run Waker');
  assert.equal(wakerRun.path.split('@')[0],
    '.github/workflows/acceptance-postrun-waker.yml');
  assert.equal(wakerRun.event, 'workflow_run');
  assert.equal(wakerRun.status, 'completed');
  assert.equal(wakerRun.conclusion, 'success');
  const selector = job(wakerJobs, 'select-staging', 'success');
  hasStep(selector, 'Authenticate completed Staging attestation ingestion');
  hasStep(selector, 'Select pending exact-SHA merged-Staging Agent criteria');
  const evaluator = job(wakerJobs, 'evaluate-staging', 'skipped');
  assert.equal(evaluator.status, 'completed');

  // This live source has NO pending matching Agent SC. The selector's skip
  // is correct: it proves negative routing, but NOT a positive Issue update.
  // Do not invent an Issue or copy the old #2984 acceptance verdict.
  console.log(JSON.stringify({
    status: 'pending',
    summary: 'Real source->append-only Store->trusted staging wake verified; no matching pending staging Agent criterion was evaluated, so canonical Issue re-evaluation is still unproven',
    evidence: [
      { type: 'runtime', value: 'Exact Case checkout ' + checkout +
        '; independent source Deploy / Identity ' + ORIGINAL_RUN +
        '/1 Staging SHA ' + STAGING_SOURCE +
        ' with immutable Store index and K8s observation' },
      { type: 'runtime', value: 'Deploy / Identity Ingest ' + INGEST_RUN +
        '/1 has successful append, readback and wake-emission steps; ' +
        'Acceptance / Post-Run Waker ' + WAKER_RUN +
        '/1 has verified source and exact-SHA staging selector steps' },
      { type: 'runtime', value: 'Matched staging Agent evaluation was skipped (no eligible outstanding criterion): a new real source->selected SC->canonical Issue update trace is required for SC-02 Pass' },
    ],
  }));
}
main().catch(error => {
  console.log(JSON.stringify({
    status: 'fail',
    summary: String(error?.message || error).slice(0,3500),
    evidence: [{ type: 'runtime', value: 'Real source/ingest/wake identity did not re-attest successfully; no SC Pass allowed' }],
  }));
  process.exitCode = 1;
});
