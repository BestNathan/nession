'use strict';
// #2592 SC-05 (runtime half): the live controller policy this fixture mirrors
// — stated-width adoption, ordered local resize, deduplicated reports — still
// passes its integration suite, and the geometry owner keeps report dedupe.
const path = require('node:path');
const {
  root, stripAnsi, passedTests, requireText, checkedIn,
} = require('../../../shared/terminal-sizing-cases.cjs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  requireText('web/src/platform/terminal-runtime/view/TerminalGeometry.ts', [
    'adoptSessionCols',
    'resizeLocalOrdered',
    'lastReported',
    'Only a width change re-runs the font fit',
  ]);

  const output = stripAnsi(checkedIn(
    path.join(root, 'web'),
    'npm',
    ['test', '--', '--project', 'integration',
      'src/platform/terminal-runtime/controller/__tests__/integration/TerminalController.test.ts'],
    600000,
  ));
  const passed = passedTests(output) ?? 0;
  if (passed < 60) {
    throw new Error('the controller integration suite did not run: ' + output.slice(-3000));
  }

  evidence.push(
    {
      type: 'source',
      value: 'exact SHA ' + sha + ': TerminalGeometry still owns adoptSessionCols, ordered local ' +
        'resize and lastReported dedupe; only a width change re-runs the fit',
    },
    {
      type: 'test',
      value: passed + ' TerminalController integration tests passed (stated-width render, observer ' +
        'adoption, ordered resize and duplicate-report dedupe)',
    },
  );
  return 'The live controller geometry policy behind the App fit remains intact';
});
