'use strict';
// #2659 SC-04 (runtime): the source-aligned mobile touch regression proves
// scroll ownership across the normal buffer, a mouse-reporting TUI and the
// alternate screen, and the gesture state machine underneath it.
const path = require('node:path');
const {
  root, stripAnsi, passedTests, checkedIn,
} = require('../../../shared/terminal-sizing-cases.cjs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

const SUITES = [
  ['integration', 'src/platform/terminal-runtime/capsule/__tests__/integration/mobileTouchScroll.test.ts'],
  ['unit', 'src/platform/terminal-runtime/capsule/__tests__/unit/occlusionScroll.test.ts'],
];

run(({ evidence }) => {
  const sha = targetSha();
  let total = 0;
  const counts = [];
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
    counts.push(path.basename(file) + '=' + passed);
    total += passed;
  }
  evidence.push({
    type: 'test',
    value: 'exact SHA ' + sha + ': ' + total + ' touch-scroll tests passed (' +
      counts.join(', ') + '); the mobile suite drives local history, mouse-reporting and ' +
      'alternate-screen ownership plus horizontal/multitouch/tap non-claims',
  });
  return 'mobile touch scroll ownership is proven across all three terminal modes';
});
