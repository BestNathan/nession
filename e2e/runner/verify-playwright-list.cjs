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
const expected = discover(path.resolve(__dirname, '..', 'tests'));
const count = verifyDiscoveredFiles(expected, files);
console.log('Playwright discovery parity: ' + count + ' stable E2E IDs');
