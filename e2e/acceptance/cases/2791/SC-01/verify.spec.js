'use strict';
// #2791 SC-01: the existing Git Changes/History flow renders one bounded patch
// through Pierre Diffs, with the file's path, line numbers and real added,
// removed and context rows. The layout switch is presentation only.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-01: a changed file renders the exact patch in both Git surfaces', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-01');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=git');
  await page.getByTestId('git-change-list').waitFor();

  const row = page.getByTestId('git-row-unstaged').first();
  const path = await row.getAttribute('data-path');
  expect(path).toBeTruthy();
  await row.click();

  await expect(page.getByTestId('git-diff-path')).toHaveText(path);
  const patch = page.getByTestId('git-diff-patch').locator('diffs-container');
  await expect(patch).toBeVisible();
  await expect(patch.locator('pre[data-diff]')).toHaveAttribute('data-diff-type', 'single');
  await expect(patch.locator('[data-column-number]').first()).toBeVisible();
  await expect(patch.locator('[data-line][data-line-type="context"]')).not.toHaveCount(0);
  await expect(patch.locator('[data-line][data-line-type="change-deletion"]')).toHaveCount(1);
  await expect(patch.locator('[data-line][data-line-type="change-addition"]')).toHaveCount(2);

  // The switch changes presentation, not identity or the Git answer.
  const unified = page.getByTestId('git-diff-layout-unified');
  const split = page.getByTestId('git-diff-layout-split');
  await expect(unified).toHaveAttribute('aria-pressed', 'true');
  await expect(split).toBeVisible();
  const diffRequests = () =>
    page.evaluate(() => window.fixtureGitDiffRequests?.length ?? 0);
  const requestsBeforeSwitch = await diffRequests();
  expect(requestsBeforeSwitch).toBeGreaterThan(0);
  await split.focus();
  await expect(split).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(patch.locator('pre[data-diff]')).toHaveAttribute('data-diff-type', 'split');
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('git-diff-loading')).toHaveCount(0);
  expect(await diffRequests()).toBe(requestsBeforeSwitch);
  await unified.focus();
  await page.keyboard.press('Enter');
  await expect(patch.locator('pre[data-diff]')).toHaveAttribute('data-diff-type', 'single');

  // History opens the same patch for a selected changed file.
  await page.getByRole('tab', { name: 'History' }).click();
  await page.getByTestId('git-commit-row').first().click();
  await expect(page.getByTestId('git-commit-detail')).toBeVisible();
  const fileRow = page.getByTestId('git-commit-file-row').first();
  await expect(fileRow).toBeVisible();
  const historyPath = await fileRow.getAttribute('data-path');
  await fileRow.click();
  await expect(page.getByTestId('git-diff-path')).toHaveText(historyPath);
  await expect(page.getByTestId('git-diff-patch').locator('diffs-container')).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Changes rendered ' + path + ' with line numbers and one ' +
      'context/deletion/addition row set; keyboard Unified↔Split changed data-diff-type ' +
      'without changing the selected row or issuing a new diff read; History rendered ' +
      historyPath + ' through the same renderer',
  });
});
