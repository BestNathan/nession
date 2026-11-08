'use strict';
// #2838 SC-01: an untracked regular text file opens its actual worktree bytes
// in a read-only, byte-bounded preview, with its path and explicit no-baseline
// status. No stage action and no invented diff.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-01: an untracked file opens a bounded preview and stays recoverable at phone width', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-01');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=git&git=preview-states');
  await page.getByTestId('git-change-list').waitFor();

  const row = page.getByTestId('git-row-untracked').filter({ hasText: 'notes/new.ts' });
  await row.click();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('git-file-preview')).toBeVisible();
  await expect(page.getByTestId('git-file-preview-path')).toHaveText('notes/new.ts');
  await expect(page.getByTestId('git-file-preview-status')).toContainText(
    'Untracked · File preview (no Git baseline)',
  );
  await expect(page.getByTestId('git-file-preview-text')).toContainText('untracked');
  await expect(page.getByTestId('git-diff-patch')).toHaveCount(0);
  // The preview itself is a reader. The row outside it may offer the #845
  // Stage action; the preview pane must not.
  await expect(
    page
      .getByTestId('git-file-preview')
      .getByRole('button', { name: /stage|commit|push|pull|checkout|discard/i }),
  ).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row).toBeFocused();
  await expect(page.getByTestId('git-file-preview-path')).toHaveText('notes/new.ts');
  const body = page.getByTestId('git-file-preview-body');
  await expect(body).toHaveCSS('overflow-y', 'auto');
  expect(
    await body.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom)),
  ).toBeGreaterThan(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': notes/new.ts selected from the Untracked group and rendered its ' +
      'actual content with the no-Git-baseline status and no diff or write control inside the ' +
      'preview pane; at 390x844 the row stayed focused, the path stayed visible, the preview ' +
      'body scrolled with positive Capsule clearance, and the page did not overflow ' +
      'horizontally',
  });
});
