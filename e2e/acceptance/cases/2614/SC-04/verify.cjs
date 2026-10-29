'use strict';
// #2614 SC-04 (runtime half): the source-aligned suites that own text paste,
// IME input, controller authority and clipboard effects still pass at the
// exact target SHA.
const path = require('node:path');
const {
  root, stripAnsi, passedTests, checkedIn,
} = require('../../../shared/terminal-sizing-cases.cjs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

const SUITES = [
  'src/platform/terminal-runtime/interaction/__tests__/integration/TerminalInteractionController.test.ts',
  'src/platform/terminal-runtime/input/__tests__/integration/MobileImeInput.test.ts',
  'src/platform/terminal-runtime/controller/__tests__/integration/TerminalControllerClipboard.test.ts',
  'src/product/terminal/patterns/__tests__/integration/TerminalSurface.test.tsx',
];

run(({ evidence }) => {
  const sha = targetSha();
  let total = 0;
  for (const file of SUITES) {
    const output = stripAnsi(checkedIn(
      path.join(root, 'web'),
      'npm',
      ['test', '--', '--project', 'integration', file],
      600000,
    ));
    const passed = passedTests(output) ?? 0;
    if (passed < 5) {
      throw new Error(file + ' did not run its suite: ' + output.slice(-2500));
    }
    total += passed;
  }
  evidence.push({
    type: 'test',
    value: 'exact SHA ' + sha + ': ' + total + ' interaction/IME/authority integration tests passed ' +
      '(PTY-bound paste and input, IME composition, observer/replay refusal, notice actions)',
  });
  return 'text paste, IME input and clipboard authority remain exact at the target SHA';
});
