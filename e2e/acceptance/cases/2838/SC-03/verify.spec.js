'use strict';
// #2838 SC-03: the existing tracked diff remains the tracked view, while a
// vanished tracked path and an unsupported entry report explicit states rather
// than empty success.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-03: tracked diffs stay intact and missing/unsupported paths are explicit', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-03');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=git');
  await page.getByTestId('git-change-list').waitFor();
  await page.getByTestId('git-row-tracked').first().click();
  await expect(page.getByTestId('git-diff-patch').locator('diffs-container')).toBeVisible();
  await expect(page.getByTestId('git-diff-path')).toHaveText('web/src/capabilities/git/GitPlugin.ts');

  await page.goto('/#/fixture/workspace?capability=git&git=diff-states');
  await page.reload();
  await page.getByTestId('git-change-list').waitFor();
  await page.getByTestId('git-row-tracked').filter({ hasText: 'src/large.ts' }).click();
  await expect(page.getByTestId('git-diff-truncated')).toContainText('4.0 KB');

  await page.goto('/#/fixture/workspace?capability=git&git=preview-states');
  await page.reload();
  await page.getByTestId('git-change-list').waitFor();
  await page.getByTestId('git-row-tracked').filter({ hasText: 'src/deleted.ts' }).click();
  await expect(page.getByTestId('git-diff-unavailable')).toContainText('no longer available');

  await page.getByTestId('git-row-untracked').filter({ hasText: 'src/link' }).click();
  await expect(page.getByTestId('git-file-preview-message')).toContainText('symbolic link');
  await expect(page.getByTestId('git-file-preview-text')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a tracked change still rendered through the #2791 Pierre diff; ' +
      'a truncated tracked diff disclosed 4.0 KB; a vanished tracked path reported [no longer ' +
      'available] instead of a blank success; an untracked symlink reported unsupported and ' +
      'returned no bytes',
  });
});
