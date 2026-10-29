'use strict';
// #2621 SC-02 (runtime half): the surface's own suite proves the actions are
// wired — Dismiss and Take control call the surface callbacks, the Copy
// gesture routes the held text through the controller, and a failed copy keeps
// a truthful message. The browser half proves the same actions in a real
// viewport.
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
    [
      'test', '--', '--project', 'integration',
      'src/product/terminal/patterns/__tests__/integration/TerminalSurface.test.tsx',
    ],
    600000,
  ));
  const passed = passedTests(output) ?? 0;
  if (passed < 15) {
    throw new Error('the TerminalSurface integration suite did not run: ' + output.slice(-2500));
  }
  evidence.push({
    type: 'test',
    value: 'exact SHA ' + sha + ': ' + passed + ' TerminalSurface integration tests passed ' +
      '(no healthy-state placeholder, overlay structure, Dismiss/Take control callbacks, ' +
      'Copy gesture routing, truthful refused-write text)',
  });
  return 'notice actions, accessibility semantics and expiry stay wired to the surface';
});
