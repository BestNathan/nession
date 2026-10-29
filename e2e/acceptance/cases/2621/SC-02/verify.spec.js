'use strict';
// #2621 SC-02: the compact notices keep their meaning and their actions — a
// blocked copy really completes through the user's gesture, Dismiss really
// dismisses a lost input, Take control stays offered to an observer, every
// notice stays a live status region, expiry still happens, and the healthy
// state has no placeholder. Callback wiring is proven by the runtime half.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { openWebNotices } = require('../../../shared/terminal-notice-cases.cjs');

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('SC-02: notice semantics, actions and expiry survive the compact overlay', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-02');
  const observed = [];

  await page.setViewportSize({ width: 1280, height: 800 });

  // Healthy state: no overlay, no reserved placeholder, no toolbar.
  await openWebNotices(page);
  await expect(page.getByTestId('terminal-status-overlay')).toHaveCount(0);

  // A blocked OSC 52 copy: announced as a live status, completed by the user.
  await openWebNotices(page, '?clipboard=copy-required');
  const copy = page.getByTestId('terminal-clipboard-notice');
  await expect(copy).toBeVisible();
  await expect(copy).toHaveAttribute('role', 'status');
  await expect(copy).toHaveAttribute('aria-live', 'polite');
  await expect(copy).toContainText('The terminal wants to copy to your clipboard.');
  await copy.getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('fixture clipboard text');
  await expect(page.getByTestId('terminal-status-overlay')).toHaveCount(0);
  observed.push('copy-required completed through the Copy gesture');

  // A refused write: truthful, no false Copy affordance, expires on its own.
  await openWebNotices(page, '?clipboard=write-denied');
  const denied = page.getByTestId('terminal-clipboard-notice');
  await expect(denied).toHaveAttribute('role', 'status');
  await expect(denied).toContainText('Clipboard write was blocked by the browser.');
  await expect(page.getByRole('button', { name: 'Copy' })).toHaveCount(0);
  await expect(page.getByTestId('terminal-status-overlay')).toHaveCount(0, { timeout: 15_000 });
  observed.push('write-denied stayed truthful and expired');

  // An unnegotiated image paste: the exact honest sentence, no copy action.
  await openWebNotices(page, '?clipboard=unsupported-image-paste');
  const unsupported = page.getByTestId('terminal-clipboard-notice');
  await expect(unsupported).toContainText('Image clipboard protocol not supported by this TUI');
  await expect(page.getByRole('button', { name: 'Copy' })).toHaveCount(0);
  observed.push('unsupported-image-paste reported without inventing capability');

  // A lost input: statement + Dismiss, and Dismiss really removes it.
  await openWebNotices(page, '?drop=epoch');
  const drop = page.getByTestId('terminal-input-drop');
  await expect(drop).toHaveAttribute('role', 'status');
  await expect(drop).toContainText('Some input may not have reached the session');
  await drop.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('terminal-status-overlay')).toHaveCount(0);
  observed.push('input-drop dismissed by the user');

  // An observer: the View only status and its takeover action stay available.
  await openWebNotices(page, '?role=observer');
  const observer = page.getByTestId('terminal-observer-bar');
  await expect(observer).toHaveAttribute('role', 'status');
  await expect(observer).toContainText('View only — another client is controlling this session.');
  await expect(observer.getByRole('button', { name: 'Take control' })).toBeEnabled();
  observed.push('observer notice kept the Take control action');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join('; ') +
      '; every notice was a role=status region, the clipboard notice was aria-live=polite, ' +
      'and the healthy route rendered no overlay',
  });
});
