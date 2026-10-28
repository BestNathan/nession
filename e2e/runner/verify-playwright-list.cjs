#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { discover, verifyDiscoveredFiles } = require('./test-catalog.cjs');

const filename = process.argv[2];
if (!filename) throw Error('Usage: node verify-playwright-list.cjs PLAYWRIGHT_LIST_FILE');
const text = fs.readFileSync(filename, 'utf8');
const files = [...text.matchAll(/(?:^|[\\/])([a-z0-9]+(?:-[a-z0-9]+)*)\.spec\.ts:[0-9]+/gm)]
  .map(match => 'tests/browser/' + match[1] + '.spec.ts');

// #2323: this step intermittently observed an empty discovery with no way to
// tell an empty/miswritten list file from a Playwright version or cwd change.
// A bounded sample of the file makes the next occurrence diagnosable without
// dumping the whole (potentially large) list into the Gate output.
function summarizeList(value) {
  const clean = String(value).replace(/\u001b\[[0-9;]*m/g, '');
  const lines = clean.split(/\r?\n/);
  return 'bytes=' + Buffer.byteLength(value) + ' lines=' + lines.length +
    ' has_listing=' + /Listing tests/i.test(clean) +
    ' has_no_tests=' + /No tests found/i.test(clean) +
    ' sample=' + JSON.stringify(lines.slice(0, 8).join('\n').slice(0, 1600));
}

if (files.length === 0) {
  throw new Error('Playwright list contained no spec paths (' + summarizeList(text) + ')');
}
const expected = discover(path.resolve(__dirname, '..', 'tests'));
const count = verifyDiscoveredFiles(expected, files);
console.log('Playwright discovery parity: ' + count + ' stable E2E IDs');
