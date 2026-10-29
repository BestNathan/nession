'use strict';
// #2592 SC-03 (runtime half): the App fit path carries no Nession minimum
// font-size clamp, and its executable tests cover the below-6 and
// width-refit/height-stable contract.
const {
  root, stripAnsi, passedTests, requireText, checkedIn,
} = require('../../../shared/terminal-sizing-cases.cjs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  requireText('web/src/platform/terminal-runtime/sizing.ts', [
    'export function fitFontToColumns',
    'FIT_SEARCH_FLOOR',
  ]);
  requireText('web/src/platform/terminal-runtime/view/TerminalGeometry.ts', [
    'fitFontToColumns({',
  ]);
  requireText('web/src/app/fixture/FixtureTerminal.tsx', [
    'fitFontToColumns({',
  ]);

  // No application floor, and no alternate name for one. The search floor is
  // the numerical bound documented in `sizing.ts`, not a product minimum.
  const fs = require('node:fs');
  const path = require('node:path');
  const sources = [
    'web/src/platform/terminal-runtime/sizing.ts',
    'web/src/platform/terminal-runtime/view/TerminalGeometry.ts',
    'web/src/app/fixture/FixtureTerminal.tsx',
  ];
  for (const rel of sources) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const forbidden of ['MIN_TERMINAL_FIT_FONT_SIZE', 'minFontSize']) {
      if (text.includes(forbidden)) {
        throw new Error(rel + ' still carries the application font floor ' + forbidden);
      }
    }
  }

  // The executable proof of the unbounded-below choice and the width/height
  // split; a removed test fails this baseline.
  requireText('web/src/platform/terminal-runtime/__tests__/unit/sizing.test.ts', [
    'chooses a font below 6 px',
    'never counts a nonpositive cell as a fit',
  ]);
  requireText('web/src/platform/terminal-runtime/view/__tests__/unit/TerminalGeometry.test.ts', [
    'fits an App-width box below 6px',
    'then only recomputes rows on height changes',
  ]);

  const output = stripAnsi(checkedIn(
    path.join(root, 'web'),
    'npm',
    ['test', '--', '--project', 'unit',
      'src/platform/terminal-runtime/__tests__/unit/sizing.test.ts',
      'src/platform/terminal-runtime/view/__tests__/unit/TerminalGeometry.test.ts'],
    300000,
  ));
  const passed = passedTests(output) ?? 0;
  if (passed < 13) {
    throw new Error('the fit tests did not run: ' + output.slice(-3000));
  }

  evidence.push(
    {
      type: 'source',
      value: 'exact SHA ' + sha + ': sizing.ts, TerminalGeometry.ts and FixtureTerminal.tsx ' +
        'contain no MIN_TERMINAL_FIT_FONT_SIZE/minFontSize application floor; the App fit ' +
        'calls fitFontToColumns with the release maximum and measured cells',
    },
    {
      type: 'test',
      value: passed + ' fit/geometry unit tests passed, including below-6 selection, ' +
        'nonpositive-cell rejection and width-refit/height-stable coverage',
    },
  );
  return 'The App font fit has no application minimum and its executable tests cover the unbounded-below contract';
});
