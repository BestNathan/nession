'use strict';
// #2592 SC-06 (runtime half): one fit owner, the approved App token, and the
// canonical docs state the measured/unbounded/centred policy. The fixture and
// the live geometry both consume `fitFontToColumns`; neither reimplements it.
const fs = require('node:fs');
const path = require('node:path');
const {
  root, stripAnsi, passedTests, requireText, checkedIn,
} = require('../../../shared/terminal-sizing-cases.cjs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  // One executable owner: both surfaces call the shared fit with the release
  // maximum and no application minimum.
  const geometry = fs.readFileSync(
    path.join(root, 'web/src/platform/terminal-runtime/view/TerminalGeometry.ts'), 'utf8',
  );
  const fixture = fs.readFileSync(
    path.join(root, 'web/src/app/fixture/FixtureTerminal.tsx'), 'utf8',
  );
  for (const [name, text] of [['TerminalGeometry', geometry], ['FixtureTerminal', fixture]]) {
    if (!text.includes('fitFontToColumns({')) {
      throw new Error(name + ' does not consume the shared measured fit');
    }
    if (!text.includes('maxFontSize:') || text.includes('minFontSize')) {
      throw new Error(name + ' does not call the fit with only the release maximum');
    }
  }

  // The App token and the generated artifact the runtime reads.
  requireText('design/tokens/experience/app.json', [
    '"value": 1.14',
    'no application minimum',
  ]);
  requireText('design/generated/terminal.ts', [
    'lineHeight: 1.14',
  ]);

  // Canonical design doctrine reflects the approved policy; Web's leading is
  // left at 1.19 in the Web token.
  requireText('docs/design/terminal/terminal-sizing.md', [
    'no Nession-imposed minimum font size',
    'centred inside the owned symmetric inset at every width',
  ]);
  requireText('design/tokens/experience/web.json', [
    '1.19',
  ]);

  const output = stripAnsi(checkedIn(
    path.join(root, 'web'),
    'npm',
    ['test', '--', '--project', 'unit',
      'src/platform/terminal-runtime/view/__tests__/unit/TerminalGeometry.test.ts'],
    300000,
  ));
  const passed = passedTests(output) ?? 0;
  if (passed < 4) {
    throw new Error('the shared geometry tests did not run: ' + output.slice(-3000));
  }

  evidence.push(
    {
      type: 'source',
      value: 'exact SHA ' + sha + ': TerminalGeometry and FixtureTerminal both consume ' +
        'fitFontToColumns with only the release maximum; no minFontSize path exists',
    },
    {
      type: 'source',
      value: 'App token lineHeight 1.14 generated into terminal.ts, Web 1.19 unchanged; ' +
        'terminal-sizing.md records the no-minimum, measured, centred policy',
    },
    {
      type: 'test',
      value: passed + ' shared TerminalGeometry tests passed',
    },
  );
  return 'Fixture and live terminal share one measured fit, one inset/centring rule and the approved App token';
});
