import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { browserDesignDigest, browserDesignTests } from './browser-design-catalog.mjs';

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Browser Design Gate verdict from real Playwright execution (#1876 Phase A).
 *
 * The design Gate used to earn its verdict by launching its own Playwright
 * processes. On Full E2E that meant the same four specs ran twice: once for the
 * design verdict and once inside `--all`. This module derives the design
 * verdict from a report the canonical suite already produced — but only from
 * evidence that can carry the claim:
 *
 * - every canonical ID is present exactly once (no missing, no duplicate run);
 * - every test finished `expected`, with no skipped/flaky/unexpected state;
 * - every attempt passed and has an authenticated assertion receipt row;
 * - the subset executed a non-zero number of assertions;
 * - the report is verified against the checked-out exact SHA, and the canonical
 *   selection digest (IDs + paths + spec content) matches this checkout.
 *
 * Anything absent or inconsistent throws. There is deliberately no "not
 * found means nothing to check" path: an empty or foreign report must fail the
 * Gate, not silently pass it.
 */

function allSpecs(suites, inheritedFile = '', output = []) {
  for (const suite of suites ?? []) {
    const file = suite.file || inheritedFile;
    for (const spec of suite.specs ?? []) {
      output.push({ ...spec, file: spec.file || file });
    }
    allSpecs(suite.suites ?? [], file, output);
  }
  return output;
}

// Only the report's top-level suites are spec files. Nested describe blocks
// inherit the same `file`, so walking recursively here would count one spec
// file as "executed many times" and fail a perfectly normal report.
function topLevelFiles(suites) {
  return (suites ?? [])
    .map((suite) => suite.file)
    .filter(Boolean)
    .map((file) => String(file).replaceAll('\\', '/'));
}

const matchesId = (file, id) => {
  const normalized = String(file).replaceAll('\\', '/');
  return normalized.endsWith('/' + id + '.spec.ts') || normalized === id + '.spec.ts';
};

function validateAssertionReceipt(assertions) {
  if (!assertions || assertions.schema_version !== 1 ||
      assertions.kind !== 'playwright_assertion_steps' ||
      !Array.isArray(assertions.tests)) {
    throw new Error('missing or invalid Playwright assertion receipt');
  }
  for (const row of assertions.tests) {
    if (!ID.test(String(row.id ?? '')) || typeof row.title !== 'string' ||
        !Number.isSafeInteger(row.line) || !Number.isSafeInteger(row.retry) ||
        typeof row.status !== 'string' ||
        !Number.isSafeInteger(row.assertions) || row.assertions < 0) {
      throw new Error('invalid assertion receipt row');
    }
  }
  return assertions.tests;
}

export function summarizeBrowserDesignReport({
  report,
  assertions,
  root,
  sha,
  actualSha,
  ids = null,
}) {
  if (!SHA.test(String(sha ?? '')) || !SHA.test(String(actualSha ?? ''))) {
    throw new Error('Browser Design verdict requires exact 40-character SHAs');
  }
  if (sha !== actualSha) {
    throw new Error(`Browser Design report SHA mismatch: report ${sha}, checkout ${actualSha}`);
  }
  if (!report || !Array.isArray(report.suites) || report.stats == null) {
    throw new Error('missing Playwright JSON report');
  }
  const canonical = browserDesignTests(root)
    .map(({ id, file }) => ({ id, file }))
    .filter(({ id }) => ids === null || ids.includes(id));
  if (!canonical.length) throw new Error('canonical Browser Design selection is empty');

  const receiptRows = validateAssertionReceipt(assertions);
  const designIds = new Set(canonical.map(({ id }) => id));
  const specs = allSpecs(report.suites);
  const files = topLevelFiles(report.suites);

  const counters = [];
  const usedRows = new Set();
  for (const { id } of canonical) {
    const occurrences = files.filter((file) => matchesId(file, id)).length;
    if (occurrences > 1) {
      throw new Error(`Browser Design spec ran more than once: ${id} (${occurrences} suites)`);
    }
    const matching = specs.filter((spec) => matchesId(spec.file, id));
    if (matching.length === 0) {
      throw new Error('Browser Design spec absent from executed report: ' + id);
    }

    const countersForId = {
      id,
      discovered: 0,
      passed: 0,
      assertions: 0,
    };
    for (const spec of matching) {
      for (const test of spec.tests ?? []) {
        countersForId.discovered += 1;
        if (test.status !== 'expected') {
          throw new Error(`Browser Design test is not expected: ${id} (${test.status})`);
        }
        if (!Array.isArray(test.results) || test.results.length === 0) {
          throw new Error('Browser Design test has no executed result: ' + id);
        }
        for (const attempt of test.results) {
          if (attempt.status !== 'passed') {
            throw new Error(`Browser Design attempt did not pass: ${id} (${attempt.status})`);
          }
          const index = receiptRows.findIndex((row, rowIndex) =>
            !usedRows.has(rowIndex) && row.id === id &&
            row.title === spec.title && row.line === spec.line &&
            row.retry === attempt.retry && row.status === attempt.status);
          if (index < 0) {
            throw new Error('missing/mismatched assertion receipt for ' + id);
          }
          usedRows.add(index);
          countersForId.assertions += receiptRows[index].assertions;
        }
        countersForId.passed += 1;
      }
    }
    if (countersForId.passed === 0) {
      throw new Error('Browser Design spec executed no tests: ' + id);
    }
    if (countersForId.assertions === 0) {
      throw new Error('Browser Design spec executed zero assertions: ' + id);
    }
    counters.push(countersForId);
  }

  // Every receipt row that belongs to the canonical design IDs must have been
  // consumed. A row left over means the receipt describes a different run.
  for (let index = 0; index < receiptRows.length; index++) {
    if (designIds.has(receiptRows[index].id) && !usedRows.has(index)) {
      throw new Error('unexpected design assertion receipt row outside the executed report: ' +
        receiptRows[index].id);
    }
  }

  const catalog = browserDesignDigest(root);
  return {
    schema_version: 1,
    kind: 'browser_design_gate',
    sha,
    catalog_digest: catalog.digest,
    ids: counters.map(({ id }) => id),
    tests: counters.reduce((sum, item) => sum + item.passed, 0),
    assertions: counters.reduce((sum, item) => sum + item.assertions, 0),
    results: counters,
    status: 'Pass',
  };
}

export function emitReceipt(result) {
  return 'BROWSER_DESIGN_GATE_V1 ' + JSON.stringify(result) + '\n';
}

function gitHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function readJson(filename, label) {
  let source;
  try {
    source = readFileSync(filename, 'utf8');
  } catch (error) {
    throw new Error(`${label} is unreadable: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

export function verifyReportFiles({ reportFile, assertionsFile, sha, root }) {
  const result = summarizeBrowserDesignReport({
    report: readJson(reportFile, 'Playwright JSON report'),
    assertions: readJson(assertionsFile, 'Playwright assertion receipt'),
    root,
    sha,
    actualSha: gitHead(),
  });
  return result;
}

export function selfTest() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'nession-design-verify-'));
  try {
    const ids = ['ui-contract-assertions', 'ui-contract-matrix', 'ui-contract-web', 'design-renderer-boundary'];
    for (const id of ids) {
      const dir = join(fixtureRoot, 'e2e', 'tests', 'browser');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.spec.ts`), `// ${id}\n`);
    }
    const reportFor = (status = 'expected', assertions = 2) => ({
      stats: {},
      suites: ids.map((id) => ({
        file: `tests/browser/${id}.spec.ts`,
        specs: [{
          title: id,
          line: 1,
          file: `tests/browser/${id}.spec.ts`,
          tests: [{
            status,
            results: [{ retry: 0, status: status === 'expected' ? 'passed' : status }],
          }],
        }],
      })),
    });
    const assertionsFor = (assertions = 2) => ({
      schema_version: 1,
      kind: 'playwright_assertion_steps',
      tests: ids.map((id) => ({
        id, title: id, line: 1, retry: 0, status: 'passed', assertions,
      })),
    });
    const sha = 'a'.repeat(40);
    const good = summarizeBrowserDesignReport({
      report: reportFor(), assertions: assertionsFor(), root: fixtureRoot, sha, actualSha: sha,
    });
    if (good.status !== 'Pass' || good.tests !== 4 || good.assertions !== 8) {
      throw new Error('self-test: valid report did not pass');
    }
    const rejects = [
      ['missing ID', () => summarizeBrowserDesignReport({
        report: { ...reportFor(), suites: reportFor().suites.slice(0, 3) },
        assertions: assertionsFor(), root: fixtureRoot, sha, actualSha: sha,
      })],
      ['skipped', () => summarizeBrowserDesignReport({
        report: reportFor('skipped'), assertions: assertionsFor(),
        root: fixtureRoot, sha, actualSha: sha,
      })],
      ['flaky', () => summarizeBrowserDesignReport({
        report: reportFor('flaky'), assertions: assertionsFor(),
        root: fixtureRoot, sha, actualSha: sha,
      })],
      ['zero assertions', () => summarizeBrowserDesignReport({
        report: reportFor(), assertions: assertionsFor(0),
        root: fixtureRoot, sha, actualSha: sha,
      })],
      ['stale SHA', () => summarizeBrowserDesignReport({
        report: reportFor(), assertions: assertionsFor(), root: fixtureRoot,
        sha, actualSha: '0'.repeat(40),
      })],
      ['missing receipt', () => summarizeBrowserDesignReport({
        report: reportFor(), assertions: null, root: fixtureRoot, sha, actualSha: sha,
      })],
    ];
    for (const [label, probe] of rejects) {
      let rejected = false;
      try { probe(); } catch { rejected = true; }
      if (!rejected) throw new Error('self-test: ' + label + ' was accepted');
    }
    console.log('Browser Design verdict self-test: valid report passes; missing/skipped/flaky/' +
      'zero-assertion/stale-SHA/missing-receipt negatives rejected');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  const arg = (name) => {
    const index = args.indexOf('--' + name);
    return index < 0 ? '' : args[index + 1] ?? '';
  };
  if (command === 'self-test') {
    selfTest();
  } else if (command === 'verify') {
    const reportFile = arg('report');
    const assertionsFile = arg('assertions');
    const sha = arg('sha');
    const output = arg('output');
    if (!reportFile || !assertionsFile || !sha) {
      throw new Error('usage: verify-browser-design-report.mjs verify --report FILE ' +
        '--assertions FILE --sha SHA [--output FILE]');
    }
    const result = verifyReportFiles({
      reportFile, assertionsFile, sha,
      root: process.cwd(),
    });
    const line = emitReceipt(result);
    process.stdout.write(line);
    if (output) {
      writeFileSync(output, line, { flag: 'wx' });
    }
  } else {
    throw new Error('usage: verify-browser-design-report.mjs self-test | verify ...');
  }
}
