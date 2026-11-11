'use strict';
// #3189 SC-01: with the Capsule kept mounted, a sent command is immediately
// visible in the History popover and its prefix completes in the ghost field;
// repeat sends move it to the front without adding a duplicate.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { openSession } = require('../../../shared/terminal-tools-browser.cjs');

test('SC-01: send updates History and ghost completion without remount', async ({ page }) => {
  test.setTimeout(240_000);
  const { runtime, sha } = verifiedRuntime('SC-01');
  await openSession(page, expect, runtime, 'case-3189-sc01', { width: 1180, height: 900 });

  const stamp = String(Date.now());
  const first = 'echo nession-history-' + stamp;
  const second = 'echo nession-second-' + stamp;
  const input = page.getByTestId('capsule-ghost-input');
  await expect(input).toBeVisible({ timeout: 15_000 });

  await input.fill(first);
  await page.getByTestId('capsule-send').click();
  await expect(input).toHaveValue('');

  // The popover was already mounted; its own state must now see the new entry.
  await page.getByTestId('capsule-history-trigger').click();
  await expect(page.getByTestId('capsule-history-item')).toHaveCount(1);
  await expect(page.getByTestId('capsule-history-item').first()).toContainText(first);
  await page.keyboard.press('Escape');

  // Prefix ghost completion reads the same live history.
  const prefix = first.slice(0, first.length - 3);
  await input.fill(prefix);
  const suffix = page.getByTestId('capsule-ghost-suffix');
  await expect(suffix).toBeVisible();
  expect((await input.inputValue()) + (await suffix.textContent())).toBe(first);
  await input.fill('');

  // A second command then a repeat of the first: recency updates, no duplicate.
  await input.fill(second);
  await page.getByTestId('capsule-send').click();
  await expect(input).toHaveValue('');
  await input.fill(first);
  await page.getByTestId('capsule-send').click();
  await expect(input).toHaveValue('');

  await page.getByTestId('capsule-history-trigger').click();
  await expect(page.getByTestId('capsule-history-item')).toHaveCount(2);
  await expect(page.getByTestId('capsule-history-item').first()).toContainText(first);
  await expect(page.getByTestId('capsule-history-item').nth(1)).toContainText(second);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the mounted Capsule History opened immediately after Send and ' +
      'showed the new command; the prefix ghost completed it; a repeat send moved it to the ' +
      'front with exactly two entries and no remount',
  });
});
