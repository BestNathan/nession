'use strict';
// #2710 SC-02: Ctrl+C, Ctrl+L and Ctrl+R are one-tap shortcuts whose PTY
// bytes are the control characters, not a sequence of literal key sends.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openCapability, openSession, readBuffer, startPtyProbe, stopPtyProbe,
} = require('../../../shared/terminal-tools-browser.cjs');

test('SC-02: one tap emits the atomic control byte for Ctrl+C/L/R', async ({ page }) => {
  test.setTimeout(240_000);
  const { runtime, sha } = verifiedRuntime('SC-02');
  await openSession(page, expect, runtime, 'case-2710-sc02');
  await startPtyProbe(page, expect, 'normal');
  await openCapability(page, expect, 'terminal-keys');

  const waitFor = async (needle, label) => {
    await expect.poll(async () => (await readBuffer(page)).includes(needle), {
      timeout: 15_000,
      message: label + ' did not reach the PTY as ' + JSON.stringify(needle),
    }).toBe(true);
  };

  await page.getByTestId('quick-chord-Ctrl+L').click();
  await waitFor('^L', 'Ctrl+L');
  await page.getByTestId('quick-chord-Ctrl+R').click();
  await waitFor('^R', 'Ctrl+R');
  // Ctrl+C kills `cat -v`; the tty echo is the proof the control byte arrived,
  // and the probe has no prompt of its own to confuse it with.
  await page.getByTestId('quick-chord-Ctrl+C').click();
  await waitFor('^C', 'Ctrl+C');

  const buffer = await readBuffer(page);
  // A sequential "modifier then letter" send would echo the literal letter.
  for (const literal of ['\nL', '\nR']) {
    expect(buffer.includes(literal), 'literal key send leaked: ' + JSON.stringify(literal)).toBe(false);
  }
  await stopPtyProbe(page);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': pty-probe normal echoed ^L, ^R and ^C from single taps on ' +
      'the Keys quick chords; no literal L/R text was produced',
  });
});
