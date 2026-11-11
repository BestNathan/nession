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

// A real positive Staging wake can come from any natural linked Issue/PR.
// Bounded one-page discovery prevents permanent reliance on an obsolete SHA.
const MAX_RECENT_ISSUES = 100;
const MAX_CANDIDATES = 12;

function section(body, title) {
  const lines = String(body ?? '').split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === '## ' + title);
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  return lines.slice(start + 1, end).join('\n');
}

function stagingAgentRows(issue) {
  const plan = section(issue.body, 'Acceptance Plan');
  const report = section(issue.body, 'Acceptance Report');
  if (!plan || !report || !Number.isSafeInteger(issue.number)) return [];
  const wanted = new Set();
  for (const match of plan.matchAll(/^ {2}(SC-[0-9]{2,}):\s*\n((?: {4}[^\n]*\n?)*)/gm)) {
    const fields = Object.fromEntries(match[2].split(/\r?\n/)
      .map(line => /^\s{4}(when|branch|method):\s*(\S+)\s*$/.exec(line))
      .filter(Boolean).map(m => [m[1], m[2]]));
    if (fields.when === 'merged' && fields.branch === 'staging' &&
        fields.method === 'agent') wanted.add(match[1]);
  }
  const out = [];
  const seen = new Set();
  for (const line of report.split(/\r?\n/)) {
    const cols = line.split('|').slice(1, -1).map(x => x.trim());
    const id = cols[0];
    if (!wanted.has(id)) continue;
    if (seen.has(id)) throw Error('duplicate Staging Agent receipt: ' + id);
    seen.add(id);
    const staged = cols.length === 4;
    if (!staged && cols.length !== 3) continue;
    if (staged && cols[1] !== 'staging') continue;
    const result = cols[staged ? 2 : 1];
    if (!['Pass', 'Pending', 'Fail'].includes(result)) continue;
    const evidence = cols[staged ? 3 : 2];
    const match = /^run ([1-9][0-9]*); ref ([a-f0-9]{40}); source (agent-[a-z0-9-]+);/.exec(evidence);
    if (match) out.push({ issue: issue.number, criterion: id,
      result, runId: Number(match[1]), sha: match[2] });
  }
  return out;
}

function matchedJob(jobs, predicate, description, attempt) {
  const matches = jobs.filter(j => predicate(String(j.name ?? '')) &&
    j.run_attempt === attempt);
  assert.equal(matches.length, 1, 'missing/ambiguous ' + description);
  assert.equal(matches[0].status, 'completed');
  assert.equal(matches[0].conclusion, 'success');
  return matches[0];
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
  const { parsePreMergeIssueNumbers } = await import(
    pathToFileURL(path.join(ROOT, 'scripts/requirement-acceptance.mjs')).href);
  const issues = await get(resource('/issues?state=all&sort=updated' +
    '&direction=desc&per_page=' + MAX_RECENT_ISSUES));
  assert.ok(Array.isArray(issues) && issues.length <= MAX_RECENT_ISSUES);
  const candidates = issues.filter(issue => !issue.pull_request)
    .flatMap(stagingAgentRows).slice(0, MAX_CANDIDATES);
  for (const row of candidates) {
    const wakerMeta = await get(resource('/actions/runs/' + row.runId));
    if (wakerMeta.name !== 'Acceptance / Post-Run Waker') continue;
    const waker = await nativeAttempt(row.runId, wakerMeta.run_attempt);
    assert.equal(waker.run.path.split('@')[0],
      '.github/workflows/acceptance-postrun-waker.yml');
    assert.equal(waker.run.event, 'workflow_run');
    assert.equal(waker.run.head_branch, 'main');
    assert.equal(waker.run.status, 'completed');
    assert.equal(waker.run.conclusion, 'success');
    const selector = matchedJob(waker.jobs, n => n === 'select-staging',
      'trusted Staging selector', waker.run.run_attempt);
    hasStep(selector, 'Authenticate completed Staging attestation ingestion');
    hasStep(selector, 'Select pending exact-SHA merged-Staging Agent criteria');
    const prefix = 'evaluate-staging (' + row.issue + ')';
    matchedJob(waker.jobs,
      n => n.startsWith(prefix + ' /') && n.endsWith('/ Execute acceptance'),
      'matched exact-Issue Staging Agent evaluator', waker.run.run_attempt);
    matchedJob(waker.jobs,
      n => n.startsWith(prefix + ' /') && n.endsWith('/ Deterministic Issue updater'),
      'matched canonical Issue updater', waker.run.run_attempt);

    const pulls = await get(resource('/commits/' + row.sha + '/pulls?per_page=100'));
    assert.ok(Array.isArray(pulls) && pulls.length < 100);
    const linked = pulls.filter(pr => pr.merged_at &&
      pr.base?.ref === 'staging' && pr.merge_commit_sha === row.sha &&
      parsePreMergeIssueNumbers(pr.body, 'BestNathan', 'nession', pr.title)
        .includes(row.issue));
    assert.equal(linked.length, 1,
      'no unique issue-linked protected Staging merge at wake target');

    // Successful Waker jobs cannot substitute for a real exact-SHA workload.
    const indexDir = 'indexes/by-sha/' + row.sha + '/deployment';
    let entries;
    try { entries = await get(normalizedPath(indexDir)); }
    catch (error) {
      if (/HTTP 404\b/.test(String(error.message))) continue;
      throw error;
    }
    assert.ok(Array.isArray(entries) && entries.length > 0 &&
      entries.length <= 100);
    const indexes = entries.filter(e => e.type === 'file' &&
      e.path.startsWith(indexDir + '/') &&
      /^[1-9][0-9]*-[1-9][0-9]*-staging\.json$/.test(e.name));
    if (!indexes.length) continue;
    for (const entry of indexes.slice(0, 3)) {
      const index = parseContents(await get(normalizedPath(entry.path)), entry.path);
      assert.equal(index.target_sha, row.sha);
      assert.equal(index.environment_id, 'staging');
      const record = parseContents(await get(normalizedPath(index.record)), index.record);
      const source = await nativeAttempt(index.source.run_id, index.source.run_attempt);
      const attested = verifySource(record, index, source.run, { jobs: source.jobs });
      assert.equal(attested.source_sha, row.sha);
      assert.equal(attested.environment_id, 'staging');
      assert.equal(attested.workload_readiness.length, 3);
      assert.ok(attested.workload_readiness.every(w =>
        w.ready && w.generation === w.observed_generation));
      assert.ok(Object.values(attested.image_digests).every(d =>
        /^sha256:[a-f0-9]{64}$/.test(d)));
      return { ...row, waker: waker.run.id,
        wakerAttempt: waker.run.run_attempt,
        source: source.run.id, sourceAttempt: source.run.run_attempt,
        record: index.record, index: entry.path,
        observedAt: attested.observed_at, pr: linked[0].number };
    }
  }
  return null;
}

function selfTestPositiveSelection() {
  const base = {
    number: 900,
    body: '## Acceptance Plan\nacceptance:\n  SC-01:\n    when: merged\n    branch: staging\n    method: agent\n  SC-02:\n    when: merged\n    branch: main\n    method: agent\n' +
      '## Acceptance Report\n| Criterion | Result | Evidence |\n|---|---|---|\n' +
      '| SC-01 | Pending | run 44; ref ' + 'a'.repeat(40) +
      '; source agent-qwen; source |\n' +
      '| SC-02 | Pending | run 55; ref ' + 'b'.repeat(40) +
      '; source agent-qwen; source |\n',
  };
  assert.deepEqual(stagingAgentRows(base), [{
    issue: 900, criterion: 'SC-01', result: 'Pending',
    runId: 44, sha: 'a'.repeat(40),
  }]);
  assert.deepEqual(stagingAgentRows({
    ...base, body: base.body.replace('method: agent', 'method: case'),
  }), []);
  assert.deepEqual(stagingAgentRows({
    ...base, body: base.body.replace('run 44;', 'not a native receipt;'),
  }), []);
  assert.deepEqual(stagingAgentRows({
    ...base, body: base.body.replace('branch: staging', 'branch: main'),
  }), []);
  assert.deepEqual(stagingAgentRows({
    ...base, body: base.body.replace('| SC-01 | Pending |',
      '| SC-01 | main | Pending |').replace('| Criterion | Result | Evidence |',
      '| Criterion | Stage | Result | Evidence |'),
  }), []);
  assert.throws(() => stagingAgentRows({
    ...base, body: base.body + '| SC-01 | Pending | run 44; ref ' +
      'a'.repeat(40) + '; source agent-qwen; duplicate |\n',
  }), /duplicate Staging Agent receipt/);
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
  selfTestPositiveSelection();
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
        { type: 'runtime', value: 'No recently linked real Staging Agent criterion has a verified matching source wake, canonical Issue updater and exact-SHA workload attestation' },
      ],
    }));
    return;
  }
  console.log(JSON.stringify({
    status: 'pass',
    summary: 'Real attested Staging source woke a matching outstanding Agent criterion through the canonical Issue updater; no SC verdict was fabricated',
    evidence: [
      { type: 'runtime', value: 'Exact Case checkout ' + checkout +
        '; observed Staging SHA ' + positive.sha + ' for linked real Issue #' +
        positive.issue + '/' + positive.criterion + ' via PR #' + positive.pr +
        '; deployment ' + positive.source + '/' +
        positive.sourceAttempt + ' at ' + positive.observedAt +
        '; immutable index ' + positive.index + '; record ' + positive.record },
      { type: 'runtime', value: 'Trusted source-bound Post-Run Waker ' +
        positive.waker + '/' + positive.wakerAttempt +
        ' selected the exact matching Staging Agent obligation; ' +
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
