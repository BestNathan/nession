#!/usr/bin/env node
// #3072: authenticate GitHub public-source reads on trusted main without
// exposing even read-only GitHub credentials to the uncredentialed Case runner.
// This is a transport adapter only. SC verification remains in the Cases.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const REPO = 'BestNathan/nession';
const ROOT = '/repos/' + REPO;
const SHA = /^[0-9a-f]{40}$/;
const SOURCE_SHA = '236f04e99a6303ade6f949bf45d56fb444de02f0';
const ORIGINAL_SHA = 'd4025428dcb79cfd273a16a66ff828cd2288eb54';
const NEGATIVE_SHA = 'f'.repeat(40);
const URL_BASE = 'https://api.github.com';
const roles = [
  ['SC-01', ORIGINAL_SHA, 42487859753, '2026-11-08'],
  ['SC-02', 'd466197f3fece03c2e04a3c546fe9edd8a7c538c', 42805092603, '2026-11-10'],
];
const rawIndex = (sha, run) =>
  'indexes/by-sha/' + sha + '/deployment/' + run + '-1-staging.json';
const recordPath = (date, run) =>
  'runs/' + date + '/' + run + '-1/deployment/staging.json';
const contentsRoute = path =>
  ROOT + '/contents/' + path + '?ref=acceptance-results';
const runRoute = id => ROOT + '/actions/runs/' + id;
const jobsRoute = id => runRoute(id) + '/attempts/1/jobs?per_page=100';
const logRoute = id => ROOT + '/actions/jobs/' + id + '/logs';

function routes() {
  const paths = [
    ROOT + '/compare/' + ORIGINAL_SHA + '...staging?per_page=1',
    contentsRoute('indexes/by-sha/' + NEGATIVE_SHA + '/deployment'),
    ROOT + '/issues/3072',
    ROOT + '/commits/' + SOURCE_SHA + '/pulls?per_page=100',
  ];
  for (const [, sha, run, date] of roles) {
    paths.push(contentsRoute(rawIndex(sha, run)));
    paths.push(contentsRoute(recordPath(date, run)));
  }
  paths.push(contentsRoute(rawIndex(SOURCE_SHA, 44932285256)));
  paths.push(contentsRoute(recordPath('2026-11-21', 44932285256)));
  for (const id of [42487859753, 42805092603, 42815588295,
    42815670151, 44932285256, 44932367574, 44932421996]) {
    paths.push(runRoute(id), jobsRoute(id));
  }
  return [...new Set(paths)];
}

function selectedCase(selection) {
  assert.ok(Array.isArray(selection) && selection.length <= 100,
    'invalid trusted Case selection');
  return selection.some(entry =>
    entry.issue === 3072 && ['SC-01', 'SC-02'].includes(entry.criterion));
}
function validateRoute(route) {
  assert.ok(route.startsWith(ROOT + '/') &&
    !/(?:^|\/)\.\.(?:\/|$)/.test(route) && !route.includes('#') &&
    !/[\r\n]/.test(route), 'unapproved GitHub read route');
}

async function capture(route, token, kind = 'json', allowMissing = false) {
  validateRoute(route);
  const response = await fetch(URL_BASE + route, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nession-trusted-case3072-prestage',
    },
    signal: AbortSignal.timeout(25000),
  });
  const status = response.status;
  if (allowMissing && status === 404) {
    return { status: 404, format: 'json', value: null };
  }
  if (!response.ok) throw Error('trusted source read unavailable: HTTP ' +
    status + ' for ' + route);
  const body = await response.text();
  assert.ok(body.length > 0 && body.length < 6000000,
    'unbounded/empty native GitHub source: ' + route);
  const value = kind === 'text' ? body : JSON.parse(body);
  return { status: 200, format: kind, value };
}

function selfTest() {
  assert.equal(routes().length, new Set(routes()).size);
  assert.ok(routes().includes(jobsRoute(44932421996)));
  assert.ok(routes().includes(contentsRoute(rawIndex(SOURCE_SHA, 44932285256))));
  assert.ok(selectedCase([{ issue: 3072, criterion: 'SC-02' }]));
  assert.ok(!selectedCase([{ issue: 3072, criterion: 'SC-04' }]));
  assert.ok(!selectedCase([{ issue: 999, criterion: 'SC-01' }]));
  assert.throws(() => validateRoute('/repos/another/repo/actions/runs/1'));
  assert.throws(() => validateRoute(ROOT + '/contents/../../secrets'));
  assert.throws(() => validateRoute(ROOT + '/issues/1\nAuthorization: token'));
  console.log('case3072 trusted GitHub read pre-stage self-test: pass');
}

async function main() {
  selfTest();
  if (process.argv[2] === '--self-test') return;
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push',
    'trusted source pre-stage is restricted to protected main push');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main',
    'trusted source pre-stage is restricted to protected main ref');
  const sha = process.env.NESSION_CASE_TARGET_SHA;
  assert.match(sha || '', SHA);
  assert.equal(sha, process.env.GITHUB_SHA,
    'trusted source pre-stage requires exact main push checkout');
  const file = process.env.NESSION_CASE_SELECTION;
  const output = process.env.NESSION_CASE_SOURCE_SNAPSHOT;
  assert.ok(file && output, 'missing trusted Case selection / output path');
  const selection = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!selectedCase(selection)) return;
  const token = process.env.GH_TOKEN;
  assert.ok(token && token.length > 10,
    'trusted GitHub source requires scoped read-only workflow token');
  const result = {};
  for (const route of routes()) {
    result[route] = await capture(route, token, 'json',
      route.includes('/contents/indexes/by-sha/' + NEGATIVE_SHA + '/'));
  }
  // Logs are discovered only from the original native Waker's authenticated
  // Job listing, never accepted from Issue prose or mutable Report fields.
  const original = result[jobsRoute(44932421996)]?.value?.jobs;
  assert.ok(Array.isArray(original) && original.length < 100);
  const wanted = [
    'select-staging',
    'evaluate-staging (3072) / Execute acceptance',
    'evaluate-staging (3072) / Deterministic Issue updater',
  ];
  for (const name of wanted) {
    const matches = original.filter(job =>
      job.name === name && job.run_attempt === 1 &&
      job.status === 'completed' && job.conclusion === 'success');
    assert.equal(matches.length, 1,
      'missing or ambiguous original Waker job: ' + name);
    result[logRoute(matches[0].id)] =
      await capture(logRoute(matches[0].id), token, 'text');
  }
  // No credentials are serialized. The next step receives only public
  // native GitHub observations captured under this trusted main workflow.
  fs.writeFileSync(output, JSON.stringify({
    schema_version: 1,
    repository: REPO,
    issue: 3072,
    target_sha: sha,
    captured_at: new Date().toISOString(),
    routes: result,
  }), { mode: 0o600, flag: 'wx' });
  console.log('Trusted read-only GitHub evidence staged for 3072 at ' +
    sha + ': ' + Object.keys(result).length + ' source responses');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
