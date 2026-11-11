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

// The earlier natural source legitimately produced no selected Agent SC. Keep
// that negative fixture, but do not freeze SC-02 permanently at Pending: a
// distinct, real matched wake can prove the positive end-to-end path.
// #3200/#3201 are an existing (not invented) outstanding Staging obligation.
const POSITIVE_ISSUE = 3200;
const POSITIVE_PR = 3201;
const POSITIVE_SHA = '03df2212e17578febb5cf2cde850bbadecb6b425';

function pendingRow(body) {
  // Read the canonical three-column Acceptance Report, not prose/comments.
  const heading = String(body).match(/^## Acceptance Report\s*$/m);
  if (!heading) throw Error('missing source Issue Acceptance Report');
  const table = String(body).slice(heading.index + heading[0].length)
    .split(/^##\s+/m, 1)[0];
  const rows = [...table.matchAll(/^\|\s*SC-02\s*\|\s*(Pass|Pending|Fail)\s*\|\s*([^|\r\n]+)\|/gm)];
  if (rows.length !== 1) throw Error('ambiguous source Issue SC-02 row');
  const match = rows[0][2].trim().match(/^run ([1-9][0-9]*); ref ([a-f0-9]{40}); source (agent-[a-z0-9-]+);/);
  if (!match) return null; // No canonical Agent receipt to correlate.
  return { result: rows[0][1], runId: Number(match[1]), sha: match[2] };
}

function matchJob(jobs, predicate, description, attempt) {
  const selected = jobs.filter(j => predicate(j.name) && j.run_attempt === attempt);
  assert.equal(selected.length, 1, 'missing/ambiguous ' + description);
  assert.equal(selected[0].status, 'completed');
  assert.equal(selected[0].conclusion, 'success');
  return selected[0];
}

async function nativeAttempt(runId, attempt) {
  assert.ok(Number.isSafeInteger(runId) && runId > 0);
  assert.ok(Number.isSafeInteger(attempt) && attempt > 0);
  const [run, jobs] = await Promise.all([
    get(resource('/actions/runs/' + runId)),
    get(resource('/actions/runs/' + runId +
      '/attempts/' + attempt + '/jobs?per_page=100')),
  ]);
  assert.equal(run.id, runId);
  assert.equal(run.run_attempt, attempt);
  assert.equal(run.repository?.full_name, REPO);
  assert.equal(run.head_repository?.full_name, REPO);
  assert.ok(Array.isArray(jobs.jobs) && jobs.jobs.length < 100);
  return { run, jobs: jobs.jobs };
}

async function verifyPositiveWake(parseContents, normalizedPath, verifySource) {
  // Correlate the real Issue receipt with its protected Staging merge, rather
  // than accepting a successful but unrelated Waker or newer workload SHA.
  const [issue, pr] = await Promise.all([
    get(resource('/issues/' + POSITIVE_ISSUE)),
    get(resource('/pulls/' + POSITIVE_PR)),
  ]);
  assert.equal(issue.number, POSITIVE_ISSUE);
  assert.ok(!issue.pull_request);
  assert.equal(pr.number, POSITIVE_PR);
  assert.equal(pr.merged, true);
  assert.equal(pr.merge_commit_sha, POSITIVE_SHA);
  assert.equal(pr.base?.ref, 'staging');
  assert.match(String(pr.title) + '\n' + String(pr.body),
    /(?:#3200|issues\/3200)/);
  assert.match(String(issue.body),
    /SC-02:\s*\n\s*when: merged\s*\n\s*branch: staging\s*\n\s*method: agent/);
  const row = pendingRow(issue.body);
  if (!row || row.sha !== POSITIVE_SHA) return null;
  const waker = await nativeAttempt(row.runId, 1);
  // The initial push Acceptance is not post-attestation reconciliation.
  if (waker.run.name !== 'Acceptance / Post-Run Waker') return null;
  assert.equal(waker.run.path.split('@')[0],
    '.github/workflows/acceptance-postrun-waker.yml');
  assert.equal(waker.run.event, 'workflow_run');
  assert.equal(waker.run.head_branch, 'main');
  assert.equal(waker.run.status, 'completed');
  assert.equal(waker.run.conclusion, 'success');
  const selector = matchJob(waker.jobs, n => n === 'select-staging',
    'source-bound Staging selector', 1);
  hasStep(selector, 'Authenticate completed Staging attestation ingestion');
  hasStep(selector, 'Select pending exact-SHA merged-Staging Agent criteria');
  const evaluator = matchJob(waker.jobs,
    n => n.includes('evaluate-staging (' + POSITIVE_ISSUE + ')') &&
      n.endsWith('/ Execute acceptance'),
    'matched Staging Agent evaluator', 1);
  const updater = matchJob(waker.jobs,
    n => n.includes('evaluate-staging (' + POSITIVE_ISSUE + ')') &&
      n.endsWith('/ Deterministic Issue updater'),
    'matched canonical Issue updater', 1);
  // Successful jobs alone are not evidence that the exact target ever ran.
  // Re-attest an immutable by-SHA Staging record and original K8s source.
  const prefix = 'indexes/by-sha/' + POSITIVE_SHA + '/deployment/';
  let entries;
  try { entries = await get(normalizedPath(prefix.slice(0, -1))); }
  catch (error) {
    if (/HTTP 404\b/.test(String(error.message))) return null;
    throw error;
  }
  assert.ok(Array.isArray(entries) && entries.length > 0 && entries.length <= 100);
  const candidates = entries.filter(e =>
    e.type === 'file' && e.path === prefix + e.name &&
    /^[1-9][0-9]*-[1-9][0-9]*-staging\.json$/.test(e.name));
  if (!candidates.length) return null;
  // A successful record must match the source SHA, original Run/attempt,
  // Ready workloads and exact image digests through the canonical verifier.
  const indexPath = candidates[0].path;
  const index = parseContents(await get(normalizedPath(indexPath)), indexPath);
  assert.equal(index.target_sha, POSITIVE_SHA);
  assert.equal(index.environment_id, 'staging');
  const recordPath = index.record;
  const record = parseContents(await get(normalizedPath(recordPath)), recordPath);
  const source = await nativeAttempt(index.source.run_id, index.source.run_attempt);
  const attested = verifySource(record, index, source.run, { jobs: source.jobs });
  assert.equal(attested.source_sha, POSITIVE_SHA);
  assert.equal(attested.environment_id, 'staging');
  assert.ok(attested.workload_readiness.length > 0);
  assert.ok(attested.workload_readiness.every(w =>
    w.ready && w.generation === w.observed_generation));
  // The current Issue row must still point to the real Waker execution,
  // not to a different / more recent evaluation with no proven provenance.
  return {
    issue: POSITIVE_ISSUE, target: POSITIVE_SHA,
    waker: waker.run.id, source: source.run.id,
    sourceAttempt: source.run.run_attempt,
    record: recordPath, index: indexPath,
    observedAt: attested.observed_at, result: row.result,
    evaluator: evaluator.name, updater: updater.name,
  };
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

  // The historical source has no matching outstanding Agent SC; that is a
  // required negative fixture, never a positive Issue projection.
  const positive = await verifyPositiveWake(parseContents, normalizedPath, verifySource);
  if (!positive) {
    console.log(JSON.stringify({
      status: 'pending',
      summary: 'Authenticated historical no-op wake is correct; awaiting a real matched post-attestation staging Agent evaluation and canonical Issue update at one observed SHA',
      evidence: [
        { type: 'runtime', value: 'Exact Case checkout ' + checkout +
          '; historical Deploy / Identity ' + ORIGINAL_RUN + '/1, Ingest ' +
          INGEST_RUN + '/1 and Waker ' + WAKER_RUN + '/1 independently re-attested' },
        { type: 'runtime', value: 'Historical evaluate-staging was correctly skipped; no unrelated successor SHA, initial push Acceptance or invented Issue can satisfy the positive wake' },
        { type: 'runtime', value: 'Natural source Issue #' + POSITIVE_ISSUE +
          ' merged at exact Staging SHA ' + POSITIVE_SHA +
          ' still has no verified matching post-attestation Issue updater trace' },
      ],
    }));
    return;
  }
  console.log(JSON.stringify({
    status: 'pass',
    summary: 'Real attested Staging source woke a matching outstanding Agent criterion through the canonical Issue updater; no SC verdict was fabricated',
    evidence: [
      { type: 'runtime', value: 'Exact Case checkout ' + checkout +
        '; observed Staging SHA ' + positive.target + ' for linked real Issue #' +
        positive.issue + '; deployment ' + positive.source + '/' +
        positive.sourceAttempt + ' at ' + positive.observedAt +
        '; immutable index ' + positive.index + '; record ' + positive.record },
      { type: 'runtime', value: 'Trusted source-bound Post-Run Waker ' +
        positive.waker + '/1 selected the exact matching Staging Agent obligation; ' +
        positive.evaluator + ' and ' + positive.updater +
        ' both completed successfully; canonical Issue result remains ' +
        positive.result + ' (not coerced to Pass)' },
      { type: 'runtime', value: 'Historical no-match Waker ' + WAKER_RUN +
        '/1 correctly skipped evaluation; forged/duplicate/source-mismatch fixtures passed' },
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
