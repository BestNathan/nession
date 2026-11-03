'use strict';
// #2663 SC-03 (runtime half): the source-aligned sense suites prove the
// classification — presence resolves Claude Code as active from the pane's
// command, while the production work bindings emit no signal for it.
const path = require('node:path');
const {
  root, stripAnsi, passedTests, checkedIn,
} = require('../../../shared/terminal-sizing-cases.cjs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

const SUITES = [
  ['unit', 'src/capabilities/claude-code/__tests__/unit/contribution.test.ts'],
  ['integration', 'src/app/__tests__/integration/useWorkSignals.test.ts'],
];

run(({ evidence }) => {
  const sha = targetSha();
  let total = 0;
  for (const [project, file] of SUITES) {
    const output = stripAnsi(checkedIn(
      path.join(root, 'web'),
      'npm',
      ['test', '--', '--project', project, file],
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
    value: 'exact SHA ' + sha + ': ' + total + ' capability-sense tests passed (CLI-open resolves ' +
      'active presence, production work bindings emit no signal, generic seam unchanged)',
  });
  return 'process presence establishes active presence, never a working status';
});
