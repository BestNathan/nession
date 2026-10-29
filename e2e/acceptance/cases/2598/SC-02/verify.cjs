'use strict';
// #2598 SC-02 (runtime half): the interaction/IME/controller owners behind the
// live terminal still pass their exact suites — committed text and paste are
// each delivered once, IME composition commits once, and a renderer replacement
// or reconnect does not duplicate input.
const path = require('node:path');
const {
  root, stripAnsi, passedTests, checkedIn,
} = require('../../../shared/terminal-sizing-cases.cjs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const suites = [
    ['src/platform/terminal-runtime/interaction/__tests__/integration/TerminalInteractionController.test.ts', 10],
    ['src/platform/terminal-runtime/input/__tests__/integration/MobileImeInput.test.ts', 10],
    ['src/platform/terminal-runtime/controller/__tests__/integration/TerminalController.test.ts', 60],
  ];
  let total = 0;
  for (const [file, minimum] of suites) {
    const output = stripAnsi(checkedIn(
      path.join(root, 'web'),
      'npm',
      ['test', '--', '--project', 'integration', file],
      600000,
    ));
    const passed = passedTests(output) ?? 0;
    if (passed < minimum) {
      throw new Error(file + ' ran ' + passed + ' passing tests, expected at least ' + minimum +
        ': ' + output.slice(-2500));
    }
    total += passed;
  }
  evidence.push({
    type: 'test',
    value: 'exact SHA ' + sha + ': ' + total + ' interaction/IME/controller integration tests ' +
      'passed (paste once, committed text once, IME composition commit, remount/reconnect input ' +
      'ownership)',
  });
  return 'The PTY-bound text and IME owners keep exact-once input across the suite';
});
