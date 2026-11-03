'use strict';
// #2659 SC-03 (runtime half): the App edge pager keeps horizontal ownership.
const path = require('node:path');
const {
  root, stripAnsi, passedTests, checkedIn,
} = require('../../../shared/terminal-sizing-cases.cjs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = stripAnsi(checkedIn(
    path.join(root, 'web'),
    'npm',
    ['test', '--', '--project', 'integration',
      'src/app/experiences/app/__tests__/integration/useSwipePager.test.ts'],
    600000,
  ));
  const passed = passedTests(output) ?? 0;
  if (passed < 5) {
    throw new Error('the swipe pager suite did not run: ' + output.slice(-2500));
  }
  evidence.push({
    type: 'test',
    value: 'exact SHA ' + sha + ': ' + passed + ' swipe-pager tests passed (edge band, axis ' +
      'surrender, commit threshold and page bounds)',
  });
  return 'the App edge pager keeps horizontal gesture ownership';
});
