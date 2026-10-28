'use strict';
// #2520 SC-05: the Rust Quality/coverage gate reports the boundary it actually
// crossed. A failed test run produces no coverage JSON; that is not "cargo
// llvm-cov is missing", and the old headline sent readers to install a tool
// while a real Rust test was panicking. The selftest injects both signatures
// and asserts the classification, including the negative case.
const path = require('node:path');
const {
  run, targetSha, checked,
} = require('../../../shared/control-mode-cases.cjs');
const { root } = require('../../../shared/terminal-sizing-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const script = path.join(root, 'scripts', 'check-coverage-selftest.sh');
  const output = checked('bash', [script], 120000);
  const summary = 'check-coverage selftest: 6 passed';
  if (!output.includes(summary)) {
    throw new Error('the coverage-gate classification selftest did not pass: ' + output.slice(-2000));
  }
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': ' + summary + ' — a libtest failure is reported as ' +
      '"Rust tests ran but failed" with the failing test named and no install ' +
      'suggestion; a missing llvm-cov keeps the install guidance and is not ' +
      'reported as a test failure',
  });
  return 'The coverage gate names a failed test run instead of misdiagnosing a missing tool';
});
