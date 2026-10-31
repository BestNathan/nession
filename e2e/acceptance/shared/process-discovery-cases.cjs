'use strict';
// Shared exact-SHA runtime steps for the #2514 Cases.
//
// Each Case still names the tests that prove its own criterion; this module
// only runs the canonical suites at the target checkout and reports the
// concrete names that passed.

const path = require('node:path');
const { checked, assertRan } = require('./control-mode-cases.cjs');
const {
  checkedIn,
  passedTests,
  stripAnsi,
} = require('./terminal-sizing-cases.cjs');

const ROOT = path.resolve(__dirname, '../../..');

/** Run the process-discovery unit tests and require every named test ran. */
function runProcessDiscoveryTests(names) {
  const output = checked(
    'cargo',
    ['test', '-p', 'nession-agent', '--lib', 'session::process_discovery', '--', '--nocapture'],
    600000,
  );
  assertRan(output, names);
  return output;
}

/** Run the Pane-identity tests in the tmux SDK. */
function runPaneIdentityTests(names) {
  const output = checked(
    'cargo',
    ['test', '-p', 'nession-tmux', '--lib', 'ops::tests::pane_rows', '--', '--nocapture'],
    300000,
  );
  assertRan(output, names);
  return output;
}

/** Run one or more Web test files and return the total passing test count. */
function runWebTests(files) {
  let total = 0;
  for (const file of files) {
    const output = stripAnsi(
      checkedIn(path.join(ROOT, 'web'), 'npm', ['test', '--', file], 600000),
    );
    const passed = passedTests(output);
    if (!passed) {
      throw new Error(file + ' ran no tests: ' + output.slice(-2500));
    }
    total += passed;
  }
  return total;
}

function readSource(relativePath) {
  const fs = require('node:fs');
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

module.exports = {
  ROOT,
  readSource,
  runPaneIdentityTests,
  runProcessDiscoveryTests,
  runWebTests,
};
