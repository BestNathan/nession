'use strict';
// #2658 SC-03: the existing HTTP user-gesture copy, event expiry and
// focus/keyboard semantics remain correct after notices became opt-in. The
// Case runs on a real non-loopback HTTP origin (no secure context, no async
// Clipboard API), which is the deployed staging condition.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { sentFrames } = require('../../../shared/terminal-clipboard-cases.cjs');
const {
  armCopyProbe, copyProbe, openHttpClipboard, originCapability, startHttpOrigin,
} = require('../../../shared/terminal-http-clipboard-cases.cjs');

const repoRoot = path.resolve(__dirname, '../../../../..');
const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

test('SC-03: HTTP gesture copy, expiry and focus survive the opt-in disclosure', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-03');
  const text = 'http-opt-in-probe';
  const origin = await startHttpOrigin(repoRoot);
  try {
    await openHttpClipboard(page, origin.origin);
    const capability = await originCapability(page);
    expect(capability.secure, 'this Case must run on a non-secure origin').toBe(false);
    expect(capability.hasAsyncClipboard, 'plain HTTP has no async Clipboard API').toBe(false);

    // Availability appears without stealing focus or mounting the payload.
    await page.locator('.xterm-helper-textarea').focus();
    await armCopyProbe(page);
    await page.evaluate((payload) => {
      window.clipboardHarness.emit('\x1b]52;c;' + payload + '\x1b\\');
    }, b64(text));
    await expect(page.getByTestId('terminal-clipboard-notice')).toHaveCount(0);
    const trigger = page.getByTestId('terminal-notices-trigger');
    await expect(trigger).toBeVisible();
    expect(await page.evaluate(
      () => document.activeElement === document.querySelector('.xterm-helper-textarea'),
    ), 'availability must not take focus').toBe(true);
    expect(await page.evaluate(() => document.body.textContent.includes('http-opt-in-probe')))
      .toBe(false);

    // The deliberate gesture opens the disclosure and completes the DOM copy.
    await trigger.click();
    const notice = page.getByTestId('terminal-clipboard-notice');
    await expect(notice).toHaveAttribute('data-clipboard-notice', 'copy-required');
    await expect(notice).toContainText('The terminal wants to copy to your clipboard.');
    await notice.getByRole('button', { name: 'Copy' }).click();
    await expect.poll(async () => (await copyProbe(page)).texts).toEqual([text]);
    const probe = await copyProbe(page);
    expect(probe.commands).toBe(1);
    expect(probe.executed, 'the browser must confirm the copy command').toBe(true);
    await expect(page.getByTestId('terminal-notice-details')).toHaveCount(0);
    await expect(trigger).toHaveCount(0);
    expect(await sentFrames(page)).toEqual([]);

    // Expiry still happens, and the terminal keeps input throughout. Leave the
    // document first: a hash-only navigation would keep the mounted fixture
    // (and its initial state) instead of applying the new route parameters.
    await page.goto('about:blank');
    await page.goto(origin.origin + '/#/fixture/clipboard?clipboard=write-denied');
    await page.getByTestId('fixture-clipboard').waitFor();
    await page.waitForFunction(() => Boolean(
      document.querySelector('[data-testid="fixture-clipboard-host"] .xterm-screen'),
    ));
    const expiryTrigger = page.getByTestId('terminal-notices-trigger');
    await expect(expiryTrigger).toBeVisible();
    await expiryTrigger.click();
    await expect(page.getByTestId('terminal-clipboard-notice'))
      .toHaveAttribute('data-clipboard-notice', 'write-denied');
    await page.keyboard.press('Escape');
    await expect(expiryTrigger).toHaveCount(0, { timeout: 15_000 });

    await page.locator('.xterm-helper-textarea').focus();
    await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
    await page.keyboard.type('after-expiry');
    await expect.poll(() => page.evaluate(() => window.clipboardHarness.sent.join('')))
      .toContain('after-expiry');

    test.info().annotations.push({
      type: 'evidence',
      description: 'exact SHA ' + sha + ': origin ' + origin.origin + ' reported ' +
        'isSecureContext=false and no navigator.clipboard; the OSC 52 write announced itself ' +
        'without focus theft or DOM payload, the explicit disclosure\'s Copy executed one DOM ' +
        'copy command carrying exactly "' + text + '" and left no action, the write-denied ' +
        'state expired on its own, and the terminal still received typed input afterwards',
    });
  } finally {
    await origin.close();
  }
});
