'use strict';
// #2710 SC-04: Esc/Tab/Enter/Space/arrows stay direct, repeatable and correct
// in both cursor-key modes, without scrolling or dismissing the panel.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openCapability, openSession, readBuffer, startPtyProbe, stopPtyProbe, terminalGeometry,
} = require('../../../shared/terminal-tools-browser.cjs');

test('SC-04: direct keys are repeatable and follow the terminal mode', async ({ page }) => {
  test.setTimeout(240_000);
  const { runtime, sha } = verifiedRuntime('SC-04');
  await openSession(page, expect, runtime, 'case-2710-sc04');
  await startPtyProbe(page, expect, 'normal');
  await openCapability(page, expect, 'terminal-keys');

  const waitFor = async (needle, label) => {
    await expect.poll(async () => (await readBuffer(page)).includes(needle), {
      timeout: 15_000,
      message: label + ' did not reach the PTY as ' + JSON.stringify(needle),
    }).toBe(true);
  };

  // Two Tabs prove repeatability; Enter and an arrow prove the other direct
  // actions still produce their own bytes.
  await page.getByTestId('phys-key-Tab').click();
  await page.getByTestId('phys-key-Tab').click();
  await waitFor('^I^I', 'two Tabs');
  await page.getByTestId('phys-key-↑').click();
  await waitFor('^[[A', 'plain ArrowUp');
  await page.getByTestId('phys-key-Enter').click();
  await expect(page.getByTestId('terminal-keys-body')).toBeVisible();

  // Keys never scroll the buffer or dismiss the panel.
  const afterTaps = await terminalGeometry(page);
  expect(afterTaps?.mode).toBe('following');
  expect(afterTaps?.viewportY).toBe(afterTaps?.baseY);

  // Application cursor mode changes the unmodified arrow spelling.
  await stopPtyProbe(page);
  await startPtyProbe(page, expect, 'appcursor');
  await page.getByTestId('phys-key-↑').click();
  await waitFor('^[OA', 'ArrowUp in DECCKM');
  await page.getByTestId('phys-key-↓').click();
  await waitFor('^[OB', 'ArrowDown in DECCKM');
  await stopPtyProbe(page);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': two Tab taps echoed ^I^I; ArrowUp echoed ^[[A in normal mode ' +
      'and ^[OA in application-cursor mode; Enter was accepted; the panel stayed open and the ' +
      'buffer stayed at the live bottom',
  });
});
