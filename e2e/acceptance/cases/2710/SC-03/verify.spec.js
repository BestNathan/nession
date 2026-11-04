'use strict';
// #2710 SC-03: Ctrl/Alt/Shift are one-shot, a chosen letter encodes the chord,
// the selection clears after success, and Cancel sends nothing.
//
// The proof runs on `/fixture/clipboard?capability=terminal-keys`, which mounts
// the production TerminalController, the production interaction encoder and the
// real Keys capability body over a harness transport. The harness records the
// exact PTY-bound bytes, so the assertion is about the chord the runtime
// produces rather than about a tty's echo.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

async function openKeysFixture(page) {
  await page.goto('about:blank');
  await page.goto('/#/fixture/clipboard?capability=terminal-keys');
  await page.getByTestId('fixture-clipboard').waitFor();
  await page.waitForFunction(() => Boolean(window.clipboardHarness));
  await page.waitForFunction(() => Boolean(
    document.querySelector('[data-testid="capsule-capability-projection"]') &&
    document.querySelector('[data-testid="terminal-keys-body"]'),
  ));
}

async function sent(page) {
  return page.evaluate(() => window.clipboardHarness.sent.slice());
}

async function clearSent(page) {
  await page.evaluate(() => {
    window.clipboardHarness.sent.length = 0;
  });
}

test('SC-03: one-shot modifiers encode one chord, clear, and cancel inertly', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-03');
  await openKeysFixture(page);

  // Ctrl + X is one control byte and clears the selection.
  await clearSent(page);
  await page.getByTestId('terminal-modifier-ctrl').click();
  await expect(page.getByTestId('terminal-modifier-ctrl')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('chord-letter-X').click();
  await expect.poll(async () => (await sent(page)).join('')).toBe('\x18');
  await expect(page.getByTestId('terminal-chord-letters')).toHaveCount(0);

  // Alt + X is the ESC-prefixed meta form.
  await clearSent(page);
  await page.getByTestId('terminal-modifier-alt').click();
  await page.getByTestId('chord-letter-X').click();
  await expect.poll(async () => (await sent(page)).join('')).toBe('\x1bx');

  // Shift + Tab is the CSI Z chord, not a tab.
  await clearSent(page);
  await page.getByTestId('terminal-modifier-shift').click();
  await page.getByTestId('phys-key-Tab').click();
  await expect.poll(async () => (await sent(page)).join('')).toBe('\x1b[Z');

  // Cancel leaves one-shot state without writing to the PTY.
  await clearSent(page);
  await page.getByTestId('terminal-modifier-ctrl').click();
  await expect(page.getByTestId('terminal-chord-letters')).toBeVisible();
  await page.getByTestId('terminal-chord-cancel').click();
  await expect(page.getByTestId('terminal-chord-letters')).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(await sent(page), 'Cancel must not send bytes').toEqual([]);

  // A common key with no modifier is still a direct key, not a chord.
  await clearSent(page);
  await page.getByTestId('phys-key-Tab').click();
  await expect.poll(async () => (await sent(page)).join('')).toBe('\t');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': production controller/encoder sent \u0018 for Ctrl+X, ' +
      '\u001bx for Alt+X and \u001b[Z for Shift+Tab; Cancel sent nothing; plain Tab sent \u0009',
  });
});
