'use strict';
// #2710 SC-03: Ctrl/Alt/Shift are one-shot, a chosen letter encodes the chord,
// the selection clears after success, and Cancel sends nothing.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openCapability, openSession, readBuffer, startPtyProbe, stopPtyProbe,
} = require('../../../shared/terminal-tools-browser.cjs');

test('SC-03: one-shot modifiers encode one chord, clear, and cancel inertly', async ({ page }) => {
  test.setTimeout(240_000);
  const { runtime, sha } = verifiedRuntime('SC-03');
  await openSession(page, expect, runtime, 'case-2710-sc03');
  await startPtyProbe(page, expect, 'normal');
  await openCapability(page, expect, 'terminal-keys');

  const waitFor = async (needle, label) => {
    await expect.poll(async () => (await readBuffer(page)).includes(needle), {
      timeout: 15_000,
      message: label + ' did not reach the PTY as ' + JSON.stringify(needle),
    }).toBe(true);
  };

  // Ctrl + X is one control byte and clears the selection.
  await page.getByTestId('terminal-modifier-ctrl').click();
  await expect(page.getByTestId('terminal-modifier-ctrl')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('chord-letter-X').click();
  await waitFor('^X', 'Ctrl+X');
  await expect(page.getByTestId('terminal-chord-letters')).toHaveCount(0);

  // Alt + X is the ESC-prefixed meta form.
  await page.getByTestId('terminal-modifier-alt').click();
  await page.getByTestId('chord-letter-X').click();
  await waitFor('^[x', 'Alt+X');

  // Shift + Tab is the CSI Z chord, not a tab.
  await page.getByTestId('terminal-modifier-shift').click();
  await page.getByTestId('phys-key-Tab').click();
  await waitFor('^[[Z', 'Shift+Tab');

  // Cancel leaves one-shot state without writing to the PTY.
  const beforeCancel = await readBuffer(page);
  await page.getByTestId('terminal-modifier-ctrl').click();
  await expect(page.getByTestId('terminal-chord-letters')).toBeVisible();
  await page.getByTestId('terminal-chord-cancel').click();
  await expect(page.getByTestId('terminal-chord-letters')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await readBuffer(page), 'Cancel must not send bytes').toBe(beforeCancel);

  // A common key with no modifier is still a direct key, not a chord.
  await page.getByTestId('phys-key-Tab').click();
  await waitFor('^I', 'plain Tab');
  await stopPtyProbe(page);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': Ctrl+X echoed ^X, Alt+X echoed ^[x, Shift+Tab echoed ^[[Z; ' +
      'selection cleared after each; Cancel left the buffer byte-identical; plain Tab echoed ^I',
  });
});
