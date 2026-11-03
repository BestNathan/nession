'use strict';
// #2656 SC-03: on a secure origin a permitted Async Clipboard write succeeds;
// a denied activation produces the truthful manual-selection state rather than
// an asynchronous fake-gesture fallback; a subsequent explicit Copy click
// invokes the shared owner inside its own activation and reports the outcome.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openNoticesDisclosure, openWebNotices,
} = require('../../../shared/terminal-notice-cases.cjs');

const FIXTURE_TEXT = 'fixture clipboard text';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('SC-03: secure-origin allow/deny and the new-click contract', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-03');

  await openWebNotices(page, '?clipboard=copy-required');
  const capability = await page.evaluate(() => ({
    secure: window.isSecureContext === true,
    hasAsyncClipboard: typeof navigator.clipboard?.writeText === 'function',
  }));
  expect(capability.secure, 'this Case must run on a secure origin').toBe(true);
  expect(capability.hasAsyncClipboard).toBe(true);

  await openNoticesDisclosure(page);
  const notice = page.getByTestId('terminal-clipboard-notice');

  // Deny both supported paths, so a claimed success would be fake.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException('denied', 'NotAllowedError');
        },
      },
    });
    document.execCommand = () => false;
  });
  await notice.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByTestId('terminal-clipboard-manual')).toHaveValue(FIXTURE_TEXT);
  await expect(notice).toContainText('could not be completed automatically');
  // The failed notice is still present: no success dismissal, no fake claim.
  await expect(page.getByTestId('terminal-clipboard-notice')).toBeVisible();

  // A fresh page restores the browser's real clipboard; the subsequent
  // explicit Copy click is a new activation and reports the real outcome.
  await openWebNotices(page, '?clipboard=copy-required');
  await openNoticesDisclosure(page);
  const retry = page.getByTestId('terminal-clipboard-notice');
  await retry.getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(FIXTURE_TEXT);
  await expect(page.getByTestId('terminal-clipboard-notice')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': secure origin (' + capability.secure +
      ', async Clipboard API present) denied writeText+execCommand produced the bounded ' +
      'manual-selection action with the exact "' + FIXTURE_TEXT + '" and kept the notice; ' +
      'a subsequent explicit Copy click on the real API completed the clipboard write with ' +
      'that exact value and dismissed the notice',
  });
});
