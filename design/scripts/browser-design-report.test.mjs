import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BROWSER_DESIGN_IDS, browserDesignDigest } from './browser-design-catalog.mjs';
import { summarizeBrowserDesignReport } from './verify-browser-design-report.mjs';

const SHA = 'a'.repeat(40);

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nession-browser-design-'));
  const dir = join(root, 'e2e', 'tests', 'browser');
  mkdirSync(dir, { recursive: true });
  for (const id of BROWSER_DESIGN_IDS) writeFileSync(join(dir, `${id}.spec.ts`), `// ${id}\n`);
  return root;
}

function report(ids = BROWSER_DESIGN_IDS, status = 'expected') {
  return {
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
  };
}

function assertions(ids = BROWSER_DESIGN_IDS, count = 2) {
  return {
    schema_version: 1,
    kind: 'playwright_assertion_steps',
    tests: ids.map((id) => ({ id, title: id, line: 1, retry: 0, status: 'passed', assertions: count })),
  };
}

test('canonical design verdict passes only with every spec, attempt and assertion proven', () => {
  const root = fixtureRoot();
  try {
    const result = summarizeBrowserDesignReport({
      report: report(), assertions: assertions(), root, sha: SHA, actualSha: SHA,
    });
    assert.equal(result.status, 'Pass');
    assert.equal(result.tests, BROWSER_DESIGN_IDS.length);
    assert.equal(result.assertions, BROWSER_DESIGN_IDS.length * 2);
    assert.equal(result.catalog_digest, browserDesignDigest(root).digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing, skipped, flaky, zero-assertion and foreign-SHA evidence is rejected', () => {
  const root = fixtureRoot();
  try {
    const base = { root, sha: SHA, actualSha: SHA };
    const negatives = [
      ['missing ID', { ...base, report: report(BROWSER_DESIGN_IDS.slice(0, -1)), assertions: assertions() }],
      ['skipped', { ...base, report: report(BROWSER_DESIGN_IDS, 'skipped'), assertions: assertions() }],
      ['flaky', { ...base, report: report(BROWSER_DESIGN_IDS, 'flaky'), assertions: assertions() }],
      ['zero assertions', { ...base, report: report(), assertions: assertions(BROWSER_DESIGN_IDS, 0) }],
      ['foreign SHA', { ...base, actualSha: '0'.repeat(40), report: report(), assertions: assertions() }],
      ['missing receipt', { ...base, report: report(), assertions: null }],
    ];
    for (const [label, input] of negatives) {
      assert.throws(() => summarizeBrowserDesignReport(input), undefined, label + ' must fail');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a duplicated suite for one canonical spec is a duplicate execution, not a Pass', () => {
  const root = fixtureRoot();
  try {
    const duplicated = report();
    duplicated.suites = [...duplicated.suites, duplicated.suites[0]];
    assert.throws(() => summarizeBrowserDesignReport({
      report: duplicated, assertions: assertions(), root, sha: SHA, actualSha: SHA,
    }), /more than once/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
