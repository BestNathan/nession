'use strict';
// #2656 SC-02: user-initiated copy from ordinary UI and the Terminal's OSC 52
// Copy notice works on a real insecure HTTP origin without navigator.clipboard,
// carrying the exact text; a refused copy offers the bounded manual-selection
// path instead of claiming success.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  armCopyProbe, copyProbe, openHttpClipboard, originCapability, startHttpOrigin,
} = require('../../../shared/terminal-http-clipboard-cases.cjs');

const repoRoot = path.resolve(__dirname, '../../../../..');
const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');
const TERMINAL_TEXT = 'terminal http copy ✓\nsecond line';
const UI_SECRET = 'staging-secret-9f2c7d';

test('SC-02: HTTP-origin UI and Terminal gesture copy carry the exact text', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-02');
  const origin = await startHttpOrigin(repoRoot);
  try {
    // --- Terminal notice: the OSC 52 payload is not in the DOM until the
    // deliberate disclosure, then the gesture carries it exactly.
    await openHttpClipboard(page, origin.origin);
    const capability = await originCapability(page);
    expect(capability.secure, 'this Case must run on a non-secure origin').toBe(false);
    expect(capability.hasAsyncClipboard, 'plain HTTP has no async Clipboard API').toBe(false);

    // Force the automatic legacy attempt to fail so the truthful user-click
    // notice path is exercised; SC-06 separately covers the permit branch.
    await page.evaluate(() => {
      const real = document.execCommand.bind(document);
      window.__sc02RealExecCommand = real;
      document.execCommand = (command, ...rest) => (
        command === 'copy' ? false : real(command, ...rest)
      );
    });
    await page.evaluate((payload) => {
      window.clipboardHarness.emit('\x1b]52;c;' + payload + '\x1b\\');
    }, b64(TERMINAL_TEXT));
    expect(
      await page.evaluate(() => document.body.textContent.includes('terminal http copy')),
      'clipboard text must not reach the DOM before the disclosure',
    ).toBe(false);

    await page.getByTestId('terminal-notices-trigger').click();
    const notice = page.getByTestId('terminal-clipboard-notice');
    await expect(notice).toHaveAttribute('data-clipboard-notice', 'copy-required');
    await page.evaluate(() => {
      document.execCommand = window.__sc02RealExecCommand;
    });
    await armCopyProbe(page);
    await notice.getByRole('button', { name: 'Copy' }).click();
    await expect.poll(async () => (await copyProbe(page)).texts).toEqual([TERMINAL_TEXT]);
    expect((await copyProbe(page)).executed).toBe(true);
    await expect(page.getByTestId('terminal-clipboard-notice')).toHaveCount(0);

    // --- Ordinary UI: the fixture Environment row action goes through the same
    // shared owner on the same insecure origin.
    await page.goto('about:blank');
    await page.goto(origin.origin + '/#/fixture/workspace?capability=env');
    await page.getByTestId('env-profile-row-server::staging.env').click();
    await page.getByTestId('env-var-copy-API_KEY').waitFor({ timeout: 25_000 });
    await armCopyProbe(page);
    await page.getByTestId('env-var-copy-API_KEY').click();
    await expect.poll(async () => (await copyProbe(page)).texts).toEqual([UI_SECRET]);
    expect((await copyProbe(page)).executed).toBe(true);
    // The copy restores the page state: the activating button keeps focus.
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
    ).toBe('env-var-copy-API_KEY');

    // --- A refused legacy command is truthful: the bounded selectable surface
    // appears and the notice is not dismissed as a successful copy.
    await page.goto('about:blank');
    await openHttpClipboard(page, origin.origin);
    await page.evaluate((payload) => {
      window.clipboardHarness.emit('\x1b]52;c;' + payload + '\x1b\\');
      document.execCommand = () => false;
    }, b64('refused copy'));
    await page.getByTestId('terminal-notices-trigger').click();
    const refused = page.getByTestId('terminal-clipboard-notice');
    await expect(refused).toHaveAttribute('data-clipboard-notice', 'copy-required');
    await refused.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByTestId('terminal-clipboard-manual')).toHaveValue('refused copy');
    await expect(refused).toContainText('press Ctrl/Cmd+C');

    test.info().annotations.push({
      type: 'evidence',
      description: 'exact SHA ' + sha + ': insecure origin ' + origin.origin +
        ' reported isSecureContext=false and no navigator.clipboard; the Terminal OSC 52 ' +
        'copy gesture carried the exact Unicode/multiline text "' +
        TERMINAL_TEXT.replace(/\n/g, '\\n') + '" (DOM payload absent before disclosure), ' +
        'the Environment UI copy carried "' + UI_SECRET + '", and a refused execCommand ' +
        'produced the bounded selectable text instead of a claimed success',
    });
  } finally {
    await origin.close();
  }
});
