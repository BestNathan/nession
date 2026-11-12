'use strict';
// #2972 SC-02: the same latest-selection ownership holds for untracked and
// unmerged previews; selecting a different path or changing Session discards
// older completions, and the real Git Changes row interaction stays usable.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

async function openSelectionOverlap(page) {
  await page.goto('/#/fixture/workspace?capability=git&git=selection-overlap');
  await expect(page.getByTestId('git-change-list')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => window.fixtureGitSelectionOverlap);
}

function previewText(page) {
  return page.getByTestId('git-file-preview-text');
}

async function releaseOlderPreview(page, fail) {
  await page.evaluate((shouldFail) => {
    window.fixtureGitSelectionOverlap.releaseOlderPreview(shouldFail);
  }, fail);
  await expect
    .poll(() => page.evaluate(() => window.fixtureGitSelectionOverlap.olderPreviewSettled()))
    .toBe(true);
}

test('SC-02: previews keep the newest selection across rows, paths and Sessions', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 1440, height: 900 });

  // Untracked: R1 held, R2 answers first, R1 released as the older success.
  await openSelectionOverlap(page);
  let row = page.getByTestId('git-row-untracked').filter({ hasText: 'notes/reselect.ts' });
  await row.click();
  await row.click();
  await expect(previewText(page)).toContainText('NEW_PREVIEW_RESPONSE notes/reselect.ts');
  expect(await page.evaluate(() => window.fixtureGitSelectionOverlap.previewRequests())).toBe(2);
  await releaseOlderPreview(page, false);
  await expect(previewText(page)).toContainText('NEW_PREVIEW_RESPONSE notes/reselect.ts');
  await expect(previewText(page)).not.toContainText('OLD_PREVIEW_RESPONSE');
  await expect(page.getByTestId('git-file-preview-error')).toHaveCount(0);

  // Unmerged: the same ownership for a conflicted preview.
  await openSelectionOverlap(page);
  row = page.getByTestId('git-row-unmerged').filter({ hasText: 'src/reselect-conflict.ts' });
  await row.click();
  await row.click();
  await expect(previewText(page)).toContainText(
    'NEW_PREVIEW_RESPONSE src/reselect-conflict.ts',
  );
  await releaseOlderPreview(page, false);
  await expect(previewText(page)).toContainText(
    'NEW_PREVIEW_RESPONSE src/reselect-conflict.ts',
  );
  await expect(previewText(page)).not.toContainText('OLD_PREVIEW_RESPONSE');

  // Different path while the older read is still in flight.
  await openSelectionOverlap(page);
  await page.getByTestId('git-row-untracked').filter({ hasText: 'notes/reselect.ts' }).click();
  await page
    .getByTestId('git-row-untracked')
    .filter({ hasText: 'notes/reselect-other.ts' })
    .click();
  await expect(previewText(page)).toContainText(
    'NEW_PREVIEW_RESPONSE notes/reselect-other.ts',
  );
  await releaseOlderPreview(page, false);
  await expect(previewText(page)).toContainText(
    'NEW_PREVIEW_RESPONSE notes/reselect-other.ts',
  );
  await expect(previewText(page)).not.toContainText('OLD_PREVIEW_RESPONSE notes/reselect.ts');

  // Session change while the older read is still in flight.
  await openSelectionOverlap(page);
  await page.getByTestId('git-row-untracked').filter({ hasText: 'notes/reselect.ts' }).click();
  await page.waitForFunction(() => typeof window.fixtureGitSelectSession === 'function');
  await page.evaluate(() => window.fixtureGitSelectSession('devbox-01:design-system'));
  await expect
    .poll(() => page.evaluate(() => window.fixtureGitSelectedSession()))
    .toBe('devbox-01:design-system');
  await releaseOlderPreview(page, false);
  await expect(previewText(page)).toHaveCount(0);
  await expect(page.getByTestId('git-file-preview')).toHaveCount(0);

  // The real row interaction remains usable after the Session move.
  await page
    .getByTestId('git-row-untracked')
    .filter({ hasText: 'notes/reselect-other.ts' })
    .click();
  await expect(previewText(page)).toContainText(
    'NEW_PREVIEW_RESPONSE notes/reselect-other.ts',
  );
  await expect(page.getByTestId('git-row-untracked')).toHaveCount(2);

  testInfo.annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: untracked and unmerged previews were each ' +
      'reselected while the first git.preview answer was held; the newer answer stayed after ' +
      'the older one was released, a different path and a Session move discarded the older ' +
      'completion, and the real Git Changes rows remained usable with no preview error',
  });
});
