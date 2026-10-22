#!/usr/bin/env node
'use strict';
// Verify that a single selected Playwright run actually executed and passed each file.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const [report, ...ids] = process.argv.slice(2);
if (!report || !ids.length) throw Error('Usage: verify-playwright-selected.cjs REPORT ID...');
const data = JSON.parse(fs.readFileSync(report, 'utf8'));
const cases = [];
function walk(suites, parent = '') {
  for (const suite of suites || []) {
    const file = suite.file || parent;
    for (const spec of suite.specs || []) cases.push({ file: spec.file || file, tests: spec.tests || [] });
    walk(suite.suites, file);
  }
}
walk(data.suites);
// Playwright reports `file` relative to rootDir in a test run but as a bare
// basename in some modes (observed with `--list`). Accept both: E2E ID stems are
// unique across the catalog, so basename matching cannot be ambiguous.
const matchesId = (file, id) => {
  const normalized = String(file).replace(/\\/g, '/');
  return normalized.endsWith('/' + id + '.spec.ts') || normalized === id + '.spec.ts';
};
for (const id of ids) {
  const tests = cases.filter(x => matchesId(x.file, id))
    .flatMap(x => x.tests);
  assert.ok(tests.length, id + ' absent from selected Playwright JSON');
  assert.ok(tests.every(t => t.status === 'expected' && t.results?.some(r => r.status === 'passed')),
    id + ' did not fully pass');
  console.log('E2E ID ' + id + ': Pass (' + tests.length + ' tests)');
}
