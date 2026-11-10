'use strict';
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { openShell, runLine, readTerminalState, seedTerminalFiles, waitForQuiet } = require('../../../shared/terminal-file-links.cjs');

test.setTimeout(90_000);

test('debug shell options', async ({ browser }) => {
  const { runtime } = verifiedRuntime('SC-02');
  seedTerminalFiles(runtime.home);
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const page = await context.newPage();
  try {
    await openShell(page, expect, runtime, 'debugopt');
    await waitForQuiet(page, expect);
    await runLine(page, expect, 'echo SHELL=$0 ZSH=$ZSH_VERSION BASH=$BASH_VERSION');
    await runLine(page, expect, 'setopt | grep -i title || echo NO_TITLE_OPT');
    const state = await readTerminalState(page);
    const lines = String(state.text).split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
    console.log('LINES', JSON.stringify(lines.slice(-14)));
  } finally {
    await context.close();
  }
});
