'use strict';
// Fixtures for the Playwright `--list` parser (#2581 main Full Regression).
//
// The verifier used to accept only a path-prefixed reference
// (`tests/browser/foo.spec.ts:12`). Playwright 1.52, with this repository's
// `testDir: './tests/browser'`, prints the file relative to testDir:
// `  foo.spec.ts:12:3 › title`. The gate therefore reported "no spec paths"
// on every real Full run. These fixtures pin every supported shape and the
// one shape that must not be treated as a file reference.
const assert = require('node:assert/strict');
const { parseSpecFiles } = require('./verify-playwright-list.cjs');

// The current Playwright 1.52 shape: testDir-relative basenames.
assert.deepEqual(
  parseSpecFiles([
    'Listing tests:',
    '  attach-critical-path.spec.ts:148:7 › Attach critical path (#1430) › fresh create',
    '  terminal-io.spec.ts:12:3 › types a key',
  ].join('\n')),
  ['tests/browser/attach-critical-path.spec.ts', 'tests/browser/terminal-io.spec.ts'],
);

// Path-prefixed and project-prefixed shapes must keep working.
assert.deepEqual(
  parseSpecFiles([
    '  [chromium] › tests/browser/terminal-consistency-faults.spec.ts:9:1 › faults',
    '  browser/ui-contract-matrix.spec.ts:4:2 › matrix',
  ].join('\n')),
  [
    'tests/browser/terminal-consistency-faults.spec.ts',
    'tests/browser/ui-contract-matrix.spec.ts',
  ],
);

// A test title may mention another spec name after the file reference; only
// the first reference on a line is the file under test.
assert.deepEqual(
  parseSpecFiles('  terminal-io.spec.ts:1:1 › explains other.spec.ts:9:9'),
  ['tests/browser/terminal-io.spec.ts'],
);

// No listing is not a parse failure here: the verifier turns an empty result
// into a failed Gate with the bounded diagnostic.
assert.deepEqual(parseSpecFiles('No tests found'), []);

console.log('verify-playwright-list fixtures passed');
