'use strict';
// #2656 SC-06: on a real non-secure HTTP Chromium origin, an authorized live
// OSC 52 automatic write must attempt the shared copy-to-clipboard path without
// a user click. When the browser permits the legacy copy, the exact bytes are
// copied and no notice appears; when it refuses, the truthful user-click Copy
// notice appears and a fresh click completes the copy.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  armCopyProbe, copyProbe, openHttpClipboard, originCapability, startHttpOrigin,
} = require('../../../shared/terminal-http-clipboard-cases.cjs');

const repoRoot = path.resolve(__dirname, '../../../../..');
const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');
const AUTOMATIC_TEXT = 'automatic http osc52 ✓\nsecond line';
const REFUSED_TEXT = 'refused automatic http copy';

test('SC-06: gesture-free OSC 52 attempts the shared copy owner on HTTP', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-06');
  const origin = await startHttpOrigin(repoRoot);
  try {
    await openHttpClipboard(page, origin.origin);
    const capability = await originCapability(page);
    expect(capability.secure, 'this Case must run on a non-secure origin').toBe(false);
    expect(capability.hasAsyncClipboard, 'plain HTTP has no async Clipboard API').toBe(false);

    // --- Actual no-gesture attempt. `commands >= 1` proves the shared
    // copy-to-clipboard path ran; `executed` is the browser's real answer.
    await armCopyProbe(page);
    await page.evaluate((payload) => {
      window.clipboardHarness.emit('\x1b]52;c;' + payload + '\x1b\\');
    }, b64(AUTOMATIC_TEXT));
    await expect.poll(async () => (await copyProbe(page)).commands, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    const attempt = await copyProbe(page);

    if (attempt.executed === true) {
      expect(attempt.texts, 'the automatic legacy copy carries the exact text')
        .toEqual([AUTOMATIC_TEXT]);
      await expect(page.getByTestId('terminal-clipboard-notice')).toHaveCount(0);
      await expect(page.getByTestId('terminal-notices-trigger')).toHaveCount(0);
    } else {
      // The browser refused the gesture-free legacy copy: the truthful
      // user-click notice must appear instead of a claimed success.
      await page.getByTestId('terminal-notices-trigger').click();
      const refused = page.getByTestId('terminal-clipboard-notice');
      await expect(refused).toHaveAttribute('data-clipboard-notice', 'copy-required');
      await expect(refused).toContainText(AUTOMATIC_TEXT);
    }

    // --- Forced-refusal negative: the automatic attempt fails deterministically
    // and the notice's fresh click, with the real command restored, copies.
    await page.goto('about:blank');
    await openHttpClipboard(page, origin.origin);
    await page.evaluate((payload) => {
      const real = document.execCommand.bind(document);
      window.__sc06RealExecCommand = real;
      document.execCommand = (command, ...rest) => (
        command === 'copy' ? false : real(command, ...rest)
      );
      window.clipboardHarness.emit('\x1b]52;c;' + payload + '\x1b\\');
    }, b64(REFUSED_TEXT));
    await page.getByTestId('terminal-notices-trigger').click();
    const notice = page.getByTestId('terminal-clipboard-notice');
    await expect(notice).toHaveAttribute('data-clipboard-notice', 'copy-required');
    await page.evaluate(() => {
      document.execCommand = window.__sc06RealExecCommand;
    });
    await armCopyProbe(page);
    await notice.getByRole('button', { name: 'Copy' }).click();
    await expect.poll(async () => (await copyProbe(page)).texts).toEqual([REFUSED_TEXT]);
    expect((await copyProbe(page)).executed).toBe(true);
    await expect(notice).toHaveCount(0);

    test.info().annotations.push({
      type: 'evidence',
      description: 'exact SHA ' + sha + ': insecure origin ' + origin.origin +
        ' reported isSecureContext=false and no navigator.clipboard; the no-click OSC 52 ' +
        'write invoked the shared copy-to-clipboard path (commands=' + attempt.commands +
        ', browser result=' + String(attempt.executed) + ')' +
        (attempt.executed === true
          ? ', copied exactly "' + AUTOMATIC_TEXT.replace(/\n/g, '\\n') + '" and showed no notice'
          : ', and its refusal showed the truthful Copy notice') +
        '; a forced refusal produced the notice and the fresh explicit Copy click carried "' +
        REFUSED_TEXT + '"',
    });
  } finally {
    await origin.close();
  }
});
