'use strict';
// #3187 SC-02: activating a Terminal file reference opens Files for the same
// Session/source at the requested line/column — on Web (pointer) and on the
// App (touch), without a second Terminal instance.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  activateReference,
  expectEditorAt,
  expectFilesSurface,
  markTerminal,
  openAppShell,
  openShell,
  printReference,
  readTerminalState,
  runLine,
  seedTerminalFiles,
} = require('../../../shared/terminal-file-links.cjs');

test.setTimeout(110_000);

test('SC-02 Web: a terminal reference opens Files at its line and column', async ({ browser }) => {
  const { runtime, sha } = verifiedRuntime('SC-02');
  seedTerminalFiles(runtime.home);
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const page = await context.newPage();
  try {
    await openShell(page, expect, runtime, 'sc02-web');
    await runLine(page, expect, 'cd src/deep');
    await printReference(page, expect, 'target.py:7:3');
    await activateReference(page, 'target.py:7:3');

    await expectFilesSurface(page, expect, 'web');
    await expectEditorAt(page, expect, {
      count: 1,
      line: 7,
      column: 3,
      activeLineText: 'target-line-7',
    });
    // Same file and source, not a lookalike.
    await expect(page.getByText('src/deep/target.py', { exact: false }).first()).toBeVisible();
    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': Web 1180 clicked `target.py:7:3` in the Terminal; Files ' +
        'opened the selected Session at src/deep/target.py with visible line 7, column 3',
    });
  } finally {
    await context.close();
  }
});

test('SC-02 App: touch opens the pushed viewer without a second Terminal', async ({ browser }) => {
  const { runtime, sha } = verifiedRuntime('SC-02');
  seedTerminalFiles(runtime.home);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await openAppShell(page, expect, runtime, 'sc02-app');
    await runLine(page, expect, 'cd src/deep');
    await printReference(page, expect, 'target.py:7:3');
    await markTerminal(page);
    await activateReference(page, 'target.py:7:3', { touch: true });

    await expectFilesSurface(page, expect, 'app');
    await expectEditorAt(page, expect, {
      count: 1,
      line: 7,
      column: 3,
      activeLineText: 'target-line-7',
    });
    const terminal = await readTerminalState(page);
    expect(terminal.xtermCount, 'navigation must not mount a second Terminal').toBe(1);
    expect(terminal.instanceMarker).toBe('original');
    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': App 390x844 tapped `target.py:7:3`; its pushed viewer opened ' +
        'src/deep/target.py at line 7, column 3 with the original single xterm still mounted',
    });
  } finally {
    await context.close();
  }
});
