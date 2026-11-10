'use strict';
// #3072 SC-01: live read-only, exact-SHA historical Staging deployment proof.
// No GitHub token or Run Store write authority reaches this Case. The target
// runner's source SHA is checked independently of the historical deployed SHA.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { targetSha } = require('../../../shared/control-mode-cases.cjs');

const ROOT = path.resolve(__dirname, '../../../../..');
const REPO = 'BestNathan/nession';
const HISTORICAL_SHA = 'd4025428dcb79cfd273a16a66ff828cd2288eb54';
const SOURCE_RUN = 42487859753;
const SOURCE_ATTEMPT = 1;
const RECORD = 'runs/2026-11-08/42487859753-1/deployment/staging.json';
const INDEX = 'indexes/by-sha/' + HISTORICAL_SHA +
  '/deployment/42487859753-1-staging.json';
const API = 'https://api.github.com';

async function read(route, { allowMissing = false } = {}) {
  assert.match(route, /^\/repos\/BestNathan\/nession\//);
  const response = await fetch(API + route, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nession-acceptance-3072-sc01',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) {
    throw Error('public read-only GitHub source unavailable for ' + route +
      ': HTTP ' + response.status);
  }
  return response.json();
}

async function main() {
  const checkout = targetSha();
  const { parseContents, normalizedPath, verifySource, selfTest } =
    await import(pathToFileURL(path.join(ROOT,
      'scripts/acceptance-staging-history-proof.mjs')).href);
  // Positive and missing/forged-source negative fixtures are executable, not
  // a "missing index = Pass" shortcut.
  await selfTest();

  // The original source remains queryable after later Staging commits. GitHub
  // itself attests ancestry, rather than inferring it from a different SHA's
  // current workload health or simply from a later wall-clock date.
  const comparison = await read('/repos/' + REPO +
    '/compare/' + HISTORICAL_SHA + '...staging?per_page=1');
  assert.equal(comparison.status, 'ahead',
    'newer Staging is not proven to descend from the historical merge');
  assert.equal(comparison.merge_base_commit?.sha, HISTORICAL_SHA);
  assert.ok(comparison.ahead_by > 0);

  const [indexSource, recordSource, nativeRun, nativeJobs] =
    await Promise.all([
      read(normalizedPath(INDEX)),
      read(normalizedPath(RECORD)),
      read('/repos/' + REPO + '/actions/runs/' + SOURCE_RUN),
      read('/repos/' + REPO + '/actions/runs/' + SOURCE_RUN +
        '/attempts/' + SOURCE_ATTEMPT + '/jobs?per_page=100'),
    ]);
  const index = parseContents(indexSource, INDEX);
  const record = parseContents(recordSource, RECORD);
  assert.equal(index.target_sha, HISTORICAL_SHA);
  assert.equal(index.record, RECORD);
  const proof = verifySource(record, index, nativeRun, nativeJobs);
  assert.equal(proof.source_sha, HISTORICAL_SHA);
  assert.equal(proof.source_run_id, SOURCE_RUN);
  assert.equal(proof.source_run_attempt, SOURCE_ATTEMPT);
  assert.equal(proof.environment_id, 'staging');
  assert.match(proof.gitops_revision, /^[a-f0-9]{40}$/);
  assert.ok(Number.isFinite(Date.parse(proof.observed_at)));
  assert.equal(proof.workload_readiness.length, 3);
  assert.deepEqual(proof.workload_readiness.map(w => w.role).sort(),
    ['agent', 'server', 'ui']);
  for (const workload of proof.workload_readiness) {
    assert.equal(workload.ready, true);
    assert.equal(workload.generation, workload.observed_generation);
    assert.match(proof.image_digests[workload.role], /^sha256:[a-f0-9]{64}$/);
  }
  // No historical observation must not be synthesized from the current
  // staging head. This deliberately absent SHA has no by-SHA index.
  const impossible = 'f'.repeat(40);
  const unknown = await read('/repos/' + REPO +
    '/contents/indexes/by-sha/' + impossible +
    '/deployment?ref=acceptance-results', { allowMissing: true });
  assert.equal(unknown, null, 'missing exact deployment index was not rejected');

  const evidence = [
    { type: 'runtime', value: 'Case checkout ' + checkout +
      '; GitHub ancestry confirms newer staging descendant, ahead=' + comparison.ahead_by +
      ' of historical deployment ' + HISTORICAL_SHA },
    { type: 'runtime', value: 'Authenticated public GitHub original Deploy / Identity Run ' +
      SOURCE_RUN + '/' + SOURCE_ATTEMPT + ' + successful Kubernetes attest Job; ' +
      'immutable index ' + INDEX + ' and record ' + RECORD +
      '; GitOps ' + proof.gitops_revision + '; observed ' + proof.observed_at },
    { type: 'runtime', value: '3/3 independent observed ready workloads with matching image digests; ' +
      'unknown exact-SHA deployment index returns 404; forged/missing source fixtures passed' },
  ];
  console.log(JSON.stringify({
    status: 'pass',
    summary: 'Real historical Staging deployment remains queryable and re-attested after newer releases; absent source is not Pass',
    evidence,
  }));
}
main().catch(error => {
  console.log(JSON.stringify({
    status: 'fail',
    summary: String(error?.message || error).slice(0,3500),
    evidence: [{ type: 'runtime', value: 'No authenticated exact-SHA historical deployment proof was established' }],
  }));
  process.exitCode = 1;
});
