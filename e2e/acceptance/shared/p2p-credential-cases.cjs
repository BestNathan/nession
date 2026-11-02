'use strict';
// Shared exact-SHA steps for the #2645 P2P credential-renewal Cases.
//
// Each Case names the tests that prove its own criterion; this module only
// runs the canonical suites at the target checkout and reads the source owners.

const fs = require('node:fs');
const path = require('node:path');
const { checked, assertRan } = require('./control-mode-cases.cjs');
const { checkedIn, passedTests, stripAnsi } = require('./terminal-sizing-cases.cjs');

const ROOT = path.resolve(__dirname, '../../..');

/**
 * Run one or more Web test files, optionally filtered by a vitest test-name
 * pattern, and return the total passing count.
 */
function runWebTests(files, namePattern = null) {
  let total = 0;
  for (const file of files) {
    const args = ['test', '--', file];
    if (namePattern) {
      args.push('-t', namePattern);
    }
    const output = stripAnsi(
      checkedIn(path.join(ROOT, 'web'), 'npm', args, 600000),
    );
    const passed = passedTests(output);
    if (!passed) {
      throw new Error(file + ' ran no tests: ' + output.slice(-2500));
    }
    total += passed;
  }
  return total;
}

/** Run a Cargo filter and require every named test to have run. */
function runCargoTests(args, names = null) {
  const output = checked('cargo', args, 900000);
  if (names) {
    assertRan(output, names);
  }
  return output;
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

module.exports = {
  ROOT,
  readSource,
  runCargoTests,
  runWebTests,
};
