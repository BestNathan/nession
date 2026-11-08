'use strict';
// #2838 SC-02: a conflicted worktree file opens its actual bytes, identified as
// an unresolved conflict, and a missing worktree file says so. A conflicted
// path appears once.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-02: an unmerged row opens one truthful conflict preview or a missing state', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=git&git=preview-states');
  await page.getByTestId('git-change-list').waitFor();

  const conflict = page.getByTestId('git-row-unmerged').filter({ hasText: 'src/conflict.ts' });
  await expect(conflict).toHaveCount(1);
  await conflict.click();
  await expect(page.getByTestId('git-file-preview-status')).toContainText(
    'Unresolved conflict · File preview',
  );
  await expect(page.getByTestId('git-file-preview-text')).toContainText('<<<<<<< HEAD');
  await expect(page.getByTestId('git-file-preview-text')).toContainText('>>>>>>> other');
  await expect(page.getByTestId('git-diff-patch')).toHaveCount(0);
  await expect(
    page.getByTestId('git-row-staged').filter({ hasText: 'src/conflict.ts' }),
  ).toHaveCount(0);
  await expect(
    page.getByTestId('git-row-unstaged').filter({ hasText: 'src/conflict.ts' }),
  ).toHaveCount(0);

  const missing = page.getByTestId('git-row-unmerged').filter({
    hasText: 'src/unmerged-missing.ts',
  });
  await missing.click();
  await expect(page.getByTestId('git-file-preview-message')).toContainText(
    'no longer present',
  );
  await expect(page.getByTestId('git-file-preview-text')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': src/conflict.ts appeared exactly once as an unmerged row; its ' +
      'preview showed the actual conflict markers under [Unresolved conflict · File preview] ' +
      'with no diff; a missing conflicted worktree file produced the explicit missing state',
  });
});
