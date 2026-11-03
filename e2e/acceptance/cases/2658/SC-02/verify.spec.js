'use strict';
// #2658 SC-02: a user can open all relevant notices from the Capsule and
// execute Dismiss, Copy and Take control without losing their meaning or
// changing PTY state. The healthy Terminal exposes no status action.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { openWebNotices } = require('../../../shared/terminal-notice-cases.cjs');
const { sentFrames } = require('../../../shared/terminal-clipboard-cases.cjs');

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('SC-02: the opt-in disclosure executes Dismiss, Copy and Take control', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-02');

  await page.setViewportSize({ width: 1280, height: 800 });

  // Healthy: no status action and no mounted notice.
  await openWebNotices(page);
  await expect(page.getByTestId('terminal-notices-trigger')).toHaveCount(0);
  await expect(page.getByTestId('terminal-notice-details')).toHaveCount(0);

  // History + dropped input + blocked copy at once.
  await openWebNotices(page, '?history=degraded&drop=epoch&clipboard=copy-required');
  const trigger = page.getByTestId('terminal-notices-trigger');
  await expect(trigger).toBeVisible();
  await expect(page.getByTestId('terminal-notice-details')).toHaveCount(0);
  await trigger.click();

  const details = page.getByTestId('terminal-notice-details');
  await expect(details).toBeVisible();
  await expect(page.getByTestId('terminal-history-degraded')).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('terminal-input-drop')).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('terminal-clipboard-notice')).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('terminal-clipboard-notice')).toHaveAttribute('aria-live', 'polite');

  const ptyBefore = await sentFrames(page);

  // Dismiss removes the lost-input statement, not the disclosure's other rows.
  await page.getByTestId('terminal-input-drop').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('terminal-input-drop')).toHaveCount(0);
  await expect(details).toBeVisible();

  // The copy gesture still completes, reading the exact text.
  await page.getByTestId('terminal-clipboard-notice').getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('fixture clipboard text');
  await expect(page.getByTestId('terminal-clipboard-notice')).toHaveCount(0);
  await expect(details).toBeVisible();

  // The terminal's PTY did not receive any status action.
  expect(await sentFrames(page)).toEqual(ptyBefore);

  // Closing returns focus to the action that opened the disclosure.
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
    .toBe('terminal-notices-trigger');

  // An observer can execute Take control from the same disclosure.
  await openWebNotices(page, '?role=observer');
  const observerTrigger = page.getByTestId('terminal-notices-trigger');
  await observerTrigger.click();
  const observer = page.getByTestId('terminal-observer-bar');
  await expect(observer).toHaveAttribute('role', 'status');
  const observerPty = await sentFrames(page);
  await observer.getByRole('button', { name: 'Take control' }).click();
  expect(await page.evaluate(() => window.clipboardHarness.takeControlCalls)).toBe(1);
  expect(await sentFrames(page)).toEqual(observerPty);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': the healthy route offered no trigger; the disclosure ' +
      'opened all three relevant notices as role=status (clipboard aria-live=polite); Dismiss ' +
      'removed only the lost-input row, Copy wrote the exact fixture text, Take control executed ' +
      'through the action once; no PTY frame was produced by any action; Escape returned focus ' +
      'to the notices trigger',
  });
});
