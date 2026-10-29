'use strict';
// #2614 SC-01: on a real HTTP origin (non-loopback, no async Clipboard API) an
// OSC 52 text write becomes a bounded, truthful user-action Copy state. The
// click completes through the DOM copy command with the exact text — no dead
// async retry, no focus theft, no false success.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  armCopyProbe, copyProbe, openHttpClipboard, originCapability, startHttpOrigin,
} = require('../../../shared/terminal-http-clipboard-cases.cjs');
const { emit, sentFrames } = require('../../../shared/terminal-clipboard-cases.cjs');

const repoRoot = path.resolve(__dirname, '../../../../..');
const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

test('SC-01: HTTP OSC 52 copy completes through a real user gesture', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-01');
  const text = 'http-osc52-probe';
  const origin = await startHttpOrigin(repoRoot);
  try {
    await openHttpClipboard(page, origin.origin);
    const capability = await originCapability(page);
    expect(capability.secure, 'this Case must run on a non-secure origin').toBe(false);
    expect(capability.hasAsyncClipboard, 'plain HTTP has no async Clipboard API').toBe(false);

    // The notice must not steal focus from the terminal it describes.
    await page.locator('.xterm-helper-textarea').focus();
    await armCopyProbe(page);
    await emit(page, '\x1b]52;c;' + b64(text) + '\x1b\\');
    const notice = page.getByTestId('terminal-clipboard-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('data-clipboard-notice', 'copy-required');
    await expect(notice).toContainText('The terminal wants to copy to your clipboard.');
    expect(await page.evaluate(() => document.activeElement === document.querySelector('.xterm-helper-textarea')),
      'the status notice must not take focus').toBe(true);

    await notice.getByRole('button', { name: 'Copy' }).click();

    // The browser executed one DOM copy and the event carried the exact text.
    await expect.poll(async () => (await copyProbe(page)).texts).toEqual([text]);
    const probe = await copyProbe(page);
    expect(probe.commands).toBe(1);
    expect(probe.executed, 'the browser must confirm the copy command').toBe(true);
    // Success is the dismissal, not a failure message.
    await expect(page.getByTestId('terminal-clipboard-notice')).toHaveCount(0);
    // No automatic write happened: OSC 52 is write-only, so the PTY saw nothing.
    expect(await sentFrames(page)).toEqual([]);

    test.info().annotations.push({
      type: 'evidence',
      description: 'exact SHA ' + sha + ': origin ' + origin.origin + ' reported ' +
        'isSecureContext=false and no navigator.clipboard; an OSC 52 write of "' + text +
        '" produced the copy-required notice without moving focus; the Copy click executed one ' +
        'DOM copy command carrying exactly "' + text + '" and dismissed the notice; no PTY bytes',
    });
  } finally {
    await origin.close();
  }
});
