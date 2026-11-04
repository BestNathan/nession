'use strict';
// #2656 SC-05 (deployed): the exact deployed revision demonstrates end-to-end
// ordinary UI and Terminal notice→click copy on a real insecure HTTP origin,
// bound by the runner to the authenticated staging deployment record.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  armCopyProbe, copyProbe, openHttpClipboard, originCapability, startHttpOrigin,
} = require('../../../shared/terminal-http-clipboard-cases.cjs');

const repoRoot = path.resolve(__dirname, '../../../../..');
const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');
const TERMINAL_TEXT = 'deployed http copy ✓';
const UI_SECRET = 'staging-secret-9f2c7d';

test('SC-05: the deployed HTTP origin copy matrix at the exact SHA', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-05');
  const origin = await startHttpOrigin(repoRoot);
  try {
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
    await openHttpClipboard(page, origin.origin);
    const capability = await originCapability(page);
    expect(capability.secure, 'the deployed matrix must run on an insecure origin').toBe(false);
    expect(capability.hasAsyncClipboard, 'plain HTTP has no async Clipboard API').toBe(false);

    // Force the automatic legacy attempt to fail so the truthful user-click
    // notice path is exercised on the deployed revision; SC-06 covers the
    // browser-permitted automatic branch separately.
    await page.evaluate(() => {
      const real = document.execCommand.bind(document);
      window.__sc05RealExecCommand = real;
      document.execCommand = (command, ...rest) => (
        command === 'copy' ? false : real(command, ...rest)
      );
    });
    await page.evaluate((payload) => {
      window.clipboardHarness.emit('\x1b]52;c;' + payload + '\x1b\\');
    }, b64(TERMINAL_TEXT));
    await page.getByTestId('terminal-notices-trigger').click();
    const notice = page.getByTestId('terminal-clipboard-notice');
    await expect(notice).toHaveAttribute('data-clipboard-notice', 'copy-required');
    await page.evaluate(() => {
      document.execCommand = window.__sc05RealExecCommand;
    });
    await armCopyProbe(page);
    await notice.getByRole('button', { name: 'Copy' }).click();
    await expect.poll(async () => (await copyProbe(page)).texts).toEqual([TERMINAL_TEXT]);
    expect((await copyProbe(page)).executed).toBe(true);
    await expect(page.getByTestId('terminal-clipboard-notice')).toHaveCount(0);

    await page.goto('about:blank');
    await page.goto(origin.origin + '/#/fixture/workspace?capability=env');
    await page.getByTestId('env-profile-row-server::staging.env').click();
    await page.getByTestId('env-var-copy-API_KEY').waitFor({ timeout: 25_000 });
    await armCopyProbe(page);
    await page.getByTestId('env-var-copy-API_KEY').click();
    await expect.poll(async () => (await copyProbe(page)).texts).toEqual([UI_SECRET]);
    expect((await copyProbe(page)).executed).toBe(true);

    test.info().annotations.push({
      type: 'evidence',
      description: 'deployed target SHA ' + sha + ' (runner-bound staging deployment record); ' +
        'insecure origin ' + origin.origin + ' on ' + userAgent +
        ' reported isSecureContext=false and no navigator.clipboard; the Terminal OSC 52 ' +
        'notice→click copy carried exactly "' + TERMINAL_TEXT + '" and dismissed; the ' +
        'Environment UI copy carried exactly "' + UI_SECRET + '"',
    });
  } finally {
    await origin.close();
  }
});
