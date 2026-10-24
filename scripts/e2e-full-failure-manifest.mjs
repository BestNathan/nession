#!/usr/bin/env node
// Candidate-only failure metadata for E2E / Full Regression (#2339).
// This read-only tool emits no Pass, no Bug authority and no failure
// fingerprint: the trusted Main-owned ingest must authenticate the source
// workflow/run/attempt/artifact before a diagnostic observation is actionable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_TESTS = 30000;
const MAX_IDS = 64;
const MAX_FAILURE_SIGNATURES_PER_ID = 8;

// Extract only a safe assertion frame basename and numeric position. Never
// copy arbitrary error text, source paths, titles, stdout, URLs or snapshots.
function safeFailureFrame(test) {
  for (const result of test?.results ?? []) {
    for (const error of [...(result.errors ?? []), ...(result.error ? [result.error] : [])]) {
      const loc = error?.location;
      if (loc && Number.isSafeInteger(loc.line) && loc.line > 0) {
        const basename = String(loc.file ?? '').replace(/\\/g, '/').split('/').at(-1);
        if (/^[A-Za-z0-9_.-]{1,100}\.spec\\.[cm]?[jt]s$/.test(basename)) {
          return basename + ':' + loc.line + (Number.isSafeInteger(loc.column) && loc.column > 0 ? ':' + loc.column : '');
        }
      }
      const frame = /(?:^|[/\\])([A-Za-z0-9_.-]{1,100}\.spec\\.[cm]?[jt]s):([1-9]\d{0,5}):([1-9]\d{0,5})/m
        .exec(String(error?.stack ?? ''));
      if (frame) return frame[1] + ':' + frame[2] + ':' + frame[3];
    }
  }
  return null;
}
const MAX_SUITES = 10000;
const positive = n => Number.isSafeInteger(n) && n > 0;

// Never copy trace URLs, assertions, stack text, test titles, cookies, source
// paths or provider credentials from an untrusted Playwright report.
export function makeCandidate(report, { sha, run_id, run_attempt }) {
  assert.match(String(sha ?? ''), SHA);
  assert.ok(positive(run_id) && positive(run_attempt), 'exact source run and attempt required');
  const base = {
    schema_version: 1, kind: 'e2e_full_failure_candidate',
    provenance: 'UNATTESTED_ARTIFACT_ONLY',
    target_sha: sha, run_id, run_attempt,
  };
  if (!report || !Array.isArray(report.suites) || !report.stats) {
    return { ...base, status: 'REPORT_UNAVAILABLE', observed_tests: 0,
      unknown_files: 0, results: [] };
  }
  const results = new Map();
  let observedTests = 0, unknownFiles = 0, visitedSuites = 0;
  const walk = (suites, inheritedFile = '') => {
    for (const suite of suites ?? []) {
      if (++visitedSuites > MAX_SUITES) throw new Error('report exceeds suite budget');
      const file = String(suite.file || inheritedFile || '').replace(/\\/g, '/');
      const specs = Array.isArray(suite.specs) ? suite.specs : [];
      for (const spec of specs) {
        const currentFile = String(spec.file || file).replace(/\\/g, '/');
        const match = currentFile.match(/(?:^|\/)([a-z0-9]+(?:-[a-z0-9]+)*)\.spec\.ts$/);
        const id = match?.[1];
        for (const test of spec.tests ?? []) {
          if (++observedTests > MAX_TESTS) throw new Error('report exceeds test budget');
          if (!id || !ID.test(id)) { unknownFiles++; continue; }
          if (!results.has(id) && results.size >= MAX_IDS) {
            throw new Error('report exceeds canonical E2E ID budget');
          }
          const r = results.get(id) ?? { id, total: 0, failed: 0, skipped: 0, flaky: 0,
            expected: 0, other: 0, failures: [] };
          r.total++;
          if (test.status === 'unexpected') {
            r.failed++;
            const stableFrame = safeFailureFrame(test);
            if (stableFrame && r.failures.length < MAX_FAILURE_SIGNATURES_PER_ID) {
              r.failures.push({ kind: 'assertion_failed', assertion_code: 'playwright_unexpected',
                stable_frame: stableFrame, affected_invariant: id, environment_specific: false });
            }
          }
          else if (test.status === 'skipped') r.skipped++;
          else if (test.status === 'flaky') r.flaky++;
          else if (test.status === 'expected') r.expected++;
          else r.other++;
          results.set(id, r);
        }
      }
      if (Array.isArray(suite.suites)) walk(suite.suites, file);
    }
  };
  walk(report.suites);
  const entries = [...results.values()].sort((a, b) => a.id.localeCompare(b.id));
  const failed = entries.reduce((sum, e) => sum + e.failed, 0);
  const pending = entries.reduce((sum, e) => sum + e.skipped + e.flaky + e.other, 0);
  // NO status here qualifies as Pass, including an entirely passing suite.
  const status = failed ? 'FAILED_TESTS_OBSERVED'
    : pending || unknownFiles ? 'NON_PASS_OR_UNKNOWN_OBSERVED'
      : report.stats.unexpected > 0 ? 'UNCLASSIFIED_FAILURE'
        : 'NO_FAILED_TESTS_OBSERVED_NOT_PASS';
  return { ...base, status, observed_tests: observedTests, unknown_files: unknownFiles,
    results: entries };
}

export function readBoundedReport(reportFile) {
  try {
    const stat = fs.statSync(reportFile);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_REPORT_BYTES) return null;
    return JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch { return null; }
}

function selfTest() {
  const context = { sha: 'a'.repeat(40), run_id: 123, run_attempt: 2 };
  const report = {
    stats: { unexpected: 1 },
    suites: [
      { file: 'tests/browser/session-lifecycle.spec.ts', specs: [{
        file: 'tests/browser/session-lifecycle.spec.ts', title: 'secret password 123',
        tests: [{ status: 'unexpected', results: [{ errors: [{ message: 'secret password=abc',
            location: { file: '/tmp/private/terminal-attach.spec.ts', line: 42, column: 9 } }] }] },
          { status: 'expected' }],
      }] },
      { file: 'tests/browser/terminal-attach.spec.ts', suites: [{
        specs: [{ tests: [{ status: 'skipped' }, { status: 'flaky' }] }],
      }] },
      { file: 'untrusted/arbitrary.html', specs: [{ tests: [{ status: 'unexpected' }] }] },
    ],
  };
  const one = makeCandidate(report, context);
  assert.equal(one.status, 'FAILED_TESTS_OBSERVED');
  assert.equal(one.observed_tests, 5);
  assert.equal(one.unknown_files, 1);
  assert.deepEqual(one.results.map(x => x.id), ['session-lifecycle', 'terminal-attach']);
  assert.equal(one.results[0].failed, 1);
  assert.deepEqual(one.results[0].failures, [{ kind: 'assertion_failed',
    assertion_code: 'playwright_unexpected', stable_frame: 'terminal-attach.spec.ts:42:9',
    affected_invariant: 'session-lifecycle', environment_specific: false }]);
  assert.equal(serialized.includes('/tmp/private'), false, 'candidate must not leak raw source paths');
  assert.equal(one.results[1].flaky, 1);
  const serialized = JSON.stringify(one);
  assert.ok(!serialized.includes('password') && !serialized.includes('secret') &&
    !serialized.includes('arbitrary.html'), 'untrusted secret or paths leaked');
  assert.equal(makeCandidate(null, context).status, 'REPORT_UNAVAILABLE');
  assert.equal(makeCandidate({ stats: {}, suites: [] }, context).status,
    'NO_FAILED_TESTS_OBSERVED_NOT_PASS');
  assert.equal(makeCandidate({ stats: { unexpected: 4 }, suites: [] }, context).status,
    'UNCLASSIFIED_FAILURE');
  assert.equal(makeCandidate({ stats: {}, suites: [
    { file: 'terminal-attach.spec.ts', specs: [{ tests: [{ status: 'skipped' }] }] },
  ] }, context).status, 'NON_PASS_OR_UNKNOWN_OBSERVED');
  assert.throws(() => makeCandidate(report, { ...context, sha: 'main' }));
  assert.throws(() => makeCandidate(report, { ...context, run_attempt: 0 }));
  assert.throws(() => makeCandidate({ stats: {}, suites: [
    { file: 'terminal-attach.spec.ts', specs: [{ tests: Array(MAX_TESTS + 1).fill({status:'expected'}) }] },
  ] }, context), /test budget/);
  console.log('e2e-full-failure-manifest self-test: PASS');
}

function main() {
  if (process.argv[2] === 'self-test') return selfTest();
  if (process.argv[2] !== 'emit') throw new Error('usage: self-test | emit REPORT OUT SHA RUN_ID ATTEMPT');
  const [reportPath, destination, sha, rawRun, rawAttempt] = process.argv.slice(3);
  if (!reportPath || !destination || !/^[1-9][0-9]*$/.test(rawRun || '') ||
      !/^[1-9][0-9]*$/.test(rawAttempt || '')) {
    throw new Error('missing exact Run / Attempt / report context');
  }
  const candidate = makeCandidate(readBoundedReport(reportPath),
    { sha, run_id: Number(rawRun), run_attempt: Number(rawAttempt) });
  fs.writeFileSync(destination, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
  console.log('E2E candidate (not authenticated): ' + candidate.status);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (e) { console.error('e2e-full-failure-manifest: ' + e.message); process.exitCode = 2; }
}
