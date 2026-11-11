'use strict';
// #2972 SC-01: two same-Session/same-path tracked-diff selections R1 then R2,
// settled R2 then R1, keep the rendered detail on R2. A late R1 failure must
// not replace R2's success or clear its loading/error state.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

async function openSelectionOverlap(page) {
  await page.goto('/#/fixture/workspace?capability=git&git=selection-overlap');
  await expect(page.getByTestId('git-change-list')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => window.fixtureGitSelectionOverlap);
  return page.getByTestId('git-row-tracked').filter({ hasText: 'src/reselect.ts' });
}

function patchText(page) {
  return page.getByTestId('git-diff-patch').locator('pre[data-diff]').first();
}

test('SC-01: an older same-row diff cannot overwrite the newer selection', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 1440, height: 900 });

  // Success: R1 is held, R2 answers first, then R1 is released.
  let row = await openSelectionOverlap(page);
  await row.click();
  await row.click();
  await expect(page.getByTestId('git-diff-patch')).toBeVisible();
  await expect(patchText(page)).toContainText('NEW_DIFF_RESPONSE');
  await expect(page.getByTestId('git-diff-truncated')).toHaveCount(0);
  expect(await page.evaluate(() => window.fixtureGitSelectionOverlap.diffRequests())).toBe(2);

  await page.evaluate(() => window.fixtureGitSelectionOverlap.releaseOlderDiff(false));
  await expect
    .poll(() => page.evaluate(() => window.fixtureGitSelectionOverlap.olderDiffSettled()))
    .toBe(true);
  await expect(patchText(page)).toContainText('NEW_DIFF_RESPONSE');
  await expect(patchText(page)).not.toContainText('OLD_DIFF_RESPONSE');
  await expect(page.getByTestId('git-diff-truncated')).toHaveCount(0);
  await expect(page.getByTestId('git-diff-error')).toHaveCount(0);
  await expect(page.getByTestId('git-diff-loading')).toHaveCount(0);

  // Failure: a late older rejection cannot replace the newer success.
  row = await openSelectionOverlap(page);
  await row.click();
  await row.click();
  await expect(patchText(page)).toContainText('NEW_DIFF_RESPONSE');
  await page.evaluate(() => window.fixtureGitSelectionOverlap.releaseOlderDiff(true));
  await expect
    .poll(() => page.evaluate(() => window.fixtureGitSelectionOverlap.olderDiffSettled()))
    .toBe(true);
  await expect(patchText(page)).toContainText('NEW_DIFF_RESPONSE');
  await expect(page.getByTestId('git-diff-error')).toHaveCount(0);
  await expect(page.getByTestId('git-diff-loading')).toHaveCount(0);

  testInfo.annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: the tracked Git Changes row was selected twice ' +
      'while the first git.diff answer was held; the second answer rendered first and the ' +
      'released older success (also marked truncated) and an older rejection both left the ' +
      'rendered detail on the newer answer with no stale marker, truncation warning, error or ' +
      'loading state',
  });
});
