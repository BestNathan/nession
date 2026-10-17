#!/usr/bin/env node
// #1876 SC-01: complete exact-SHA Full E2E per-ID execution receipt.
// Canonical file-ID list comes from e2e/runner/test-catalog.cjs. The existing
// selected-report classifier independently joins JSON tests to Playwright's
// execution-time assertion reporter. A reporter/ID mismatch is never Pass.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { summarize } from './selected-report.mjs';

const require = createRequire(import.meta.url);
const { discover } = require('./test-catalog.cjs');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PREFIX = 'E2E_FULL_PER_ID_V1 ';
const hash = s => createHash('sha256').update(s).digest('hex');
const positive = n => Number.isSafeInteger(n) && n > 0;

export function verifyFull(report, assertions, catalog, sha) {
  assert.ok(SHA.test(sha), 'exact Full E2E SHA is required');
  assert.ok(Array.isArray(catalog) && catalog.length > 0 && catalog.length <= 64,
    'bounded Full E2E test catalog required');
  assert.ok(catalog.every(x => ID.test(x.id) && x.file.endsWith('/' + x.id + '.spec.ts')),
    'invalid Full E2E catalog');
  assert.equal(new Set(catalog.map(x => x.id)).size, catalog.length,
    'duplicate canonical Full E2E IDs');
  assert.ok(report?.stats && Array.isArray(report?.suites), 'no full Playwright JSON report');
  const stats = report.stats;
  assert.ok(positive(stats.expected) && stats.unexpected === 0 &&
    stats.skipped === 0 && stats.flaky === 0, 'full Playwright report is not an all-Pass run');
  const plan = { schema_version: 1, kind: 'issue_e2e_selection', mode: 'selected',
    target_sha: sha, plan_digest: hash(JSON.stringify(catalog)),
    selected: catalog.map(x => ({ id: x.id })) };
  const evidence = summarize(plan, report, assertions);
  assert.equal(evidence.status, 'Pass', 'some canonical IDs lack passing assertion proof');
  const total = evidence.results.reduce((n, r) => n + r.discovered, 0);
  const assertionsTotal = evidence.results.reduce((n, r) => n + r.assertions, 0);
  assert.equal(total, stats.expected, 'Playwright JSON and full catalog count disagree');
  assert.ok(assertionsTotal > 0, 'zero full E2E assertions');
  return { schema_version: 1, kind: 'e2e_full_per_id', sha,
    catalog_digest: plan.plan_digest,
    id_count: catalog.length, tests: total, assertions: assertionsTotal,
    results: evidence.results, status: 'Pass' };
}

export function attestFullReceipt(receipt, run, job) {
  assert.equal(receipt?.schema_version, 1);
  assert.equal(receipt?.kind, 'e2e_full_per_id');
  assert.equal(receipt?.status, 'Pass');
  assert.ok(SHA.test(receipt.sha));
  assert.ok(positive(receipt.run_id) && positive(receipt.run_attempt));
  assert.ok(/^[a-f0-9]{64}$/.test(receipt.catalog_digest));
  assert.ok(positive(receipt.id_count) && receipt.id_count <= 64);
  assert.ok(positive(receipt.tests) && positive(receipt.assertions));
  assert.ok(Array.isArray(receipt.results) && receipt.results.length === receipt.id_count);
  assert.equal(new Set(receipt.results.map(x => x.id)).size, receipt.id_count);
  let tests = 0, assertions = 0;
  for (const x of receipt.results) {
    assert.ok(ID.test(x.id) && x.result === 'Pass' && positive(x.discovered) &&
      x.discovered === x.passed && positive(x.assertions) && x.failed === 0 &&
      x.skipped === 0 && x.flaky === 0, 'invalid full per-ID result');
    tests += x.discovered; assertions += x.assertions;
  }
  assert.equal(tests, receipt.tests);
  assert.equal(assertions, receipt.assertions);
  assert.equal(run?.id, receipt.run_id);
  assert.equal(run?.run_attempt, receipt.run_attempt);
  assert.equal(run?.head_sha, receipt.sha);
  assert.equal(run?.event, 'push');
  assert.ok(['staging', 'main'].includes(run?.head_branch));
  assert.equal(run?.name, 'E2E / Tests');
  assert.equal(run?.path, '.github/workflows/e2e-tests.yml');
  assert.equal(run?.repository?.full_name, 'BestNathan/nession');
  assert.equal(run?.head_repository?.full_name, 'BestNathan/nession');
  assert.equal(run?.status, 'completed');
  assert.equal(run?.conclusion, 'success');
  assert.equal(job?.run_id, run.id);
  assert.equal(job?.run_attempt, run.run_attempt);
  assert.equal(job?.head_sha, run.head_sha);
  assert.equal(job?.name, 'e2e');
  assert.equal(job?.status, 'completed');
  assert.equal(job?.conclusion, 'success');
  const steps = job?.steps?.filter(s => s.name === 'Attest Full E2E per-ID assertion coverage') ?? [];
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, 'completed');
  assert.equal(steps[0].conclusion, 'success');
  return { ...receipt, provenance: 'authenticated push Run/Attempt/SHA + per-ID verifier step success' };
}

function selfTest() {
  const sha = 'a'.repeat(40), ids = ['login', 'session-lifecycle'];
  const catalog = ids.map(id => ({ id, file: 'tests/browser/' + id + '.spec.ts' }));
  const report = { stats: { expected: 2, unexpected: 0, skipped: 0, flaky: 0 },
    suites: ids.map(id => ({ file: id + '.spec.ts', specs: [{ file: id + '.spec.ts',
      title: id, line: 8, tests: [{ status: 'expected', results: [{ retry: 0, status: 'passed' }] }] }] })) };
  const assertions = { schema_version: 1, kind: 'playwright_assertion_steps',
    tests: ids.map(id => ({ id, title: id, line: 8, retry: 0, status: 'passed', assertions: 2 })) };
  const receipt = { ...verifyFull(report, assertions, catalog, sha), run_id: 21, run_attempt: 2 };
  assert.equal(receipt.tests, 2);
  const run = { id: 21, run_attempt: 2, head_sha: sha, event: 'push', head_branch: 'main',
    name: 'E2E / Tests', path: '.github/workflows/e2e-tests.yml',
    repository: { full_name: 'BestNathan/nession' },
    head_repository: { full_name: 'BestNathan/nession' }, status: 'completed', conclusion: 'success' };
  const job = { run_id: 21, run_attempt: 2, head_sha: sha, name: 'e2e', status: 'completed',
    conclusion: 'success', steps: [{ name: 'Attest Full E2E per-ID assertion coverage',
      status: 'completed', conclusion: 'success' }] };
  assert.equal(attestFullReceipt(receipt, run, job).status, 'Pass');
  for (const [r, a, c] of [
    [{...report,stats:{...report.stats,skipped:1}},assertions,catalog],
    [{...report,stats:{...report.stats,expected:3}},assertions,catalog],
    [report,{...assertions,tests:assertions.tests.slice(1)},catalog],
    [report,{...assertions,tests:[...assertions.tests,{...assertions.tests[0]}]},catalog],
    [report,{...assertions,tests:assertions.tests.map(x=>({...x,assertions:0}))},catalog],
    [report,assertions,catalog.slice(0,1)],
  ]) assert.throws(() => verifyFull(r,a,c,sha));
  for (const [rec,ru,j] of [
    [{...receipt,sha:'b'.repeat(40)},run,job],
    [receipt,{...run,event:'pull_request'},job],
    [receipt,run,{...job,conclusion:'failure'}],
    [receipt,run,{...job,steps:[]}],
    [{...receipt,results:receipt.results.map(x=>({...x,assertions:0}))},run,job],
  ]) assert.throws(() => attestFullReceipt(rec,ru,j));
  console.log('Full E2E per-ID receipt: 11 fail-closed tests passed');
}

if (process.argv[2] === 'self-test') selfTest();
else if (process.argv[2] === 'verify') {
  const [jsonFile, assertionFile, sha] = process.argv.slice(3);
  if (!jsonFile || !assertionFile || !SHA.test(sha ?? '')) throw Error('verify JSON ASSERTIONS SHA');
  const catalog = discover(path.join(ROOT, 'e2e/tests/browser'));
  const receipt = verifyFull(JSON.parse(fs.readFileSync(jsonFile, 'utf8')),
    JSON.parse(fs.readFileSync(assertionFile, 'utf8')), catalog, sha);
  const run_id = Number(process.env.GITHUB_RUN_ID), run_attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (!positive(run_id) || !positive(run_attempt)) throw Error('GitHub Run/Attempt required');
  console.log(PREFIX + JSON.stringify({...receipt,run_id,run_attempt}));
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw Error('usage: e2e-full-per-id-receipt.mjs self-test | verify JSON ASSERTIONS SHA');
}
