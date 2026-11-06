'use strict';
// #2838 SC-06: the existing Git Changes regression opens untracked and conflict
// rows at desktop and narrow App-like widths, with focus, scroll and Capsule
// clearance preserved, and no Files/editor/merge/write control added.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-06: previews preserve the Git shell and its focus/scroll/read-only contract', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-06');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/workspace?capability=git&git=preview-states');
  await page.getByTestId('git-change-list').waitFor();

  const row = page.getByTestId('git-row-untracked').filter({ hasText: 'src/long-preview.txt' });
  await row.click();
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute('aria-current', 'true');
  const body = page.getByTestId('git-file-preview-body');
  await expect(body).toHaveCSS('overflow-y', 'auto');
  const scroll = await body.evaluate((element) => {
    element.scrollTop = 200;
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      pad: Number.parseFloat(getComputedStyle(element).paddingBottom),
    };
  });
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  expect(scroll.scrollTop).toBeGreaterThan(0);
  expect(scroll.pad).toBeGreaterThan(0);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  const workspace = await page.getByTestId('git-workspace').boundingBox();
  expect(workspace).not.toBeNull();
  expect(workspace?.x ?? 0).toBeGreaterThanOrEqual(0);
  expect((workspace?.x ?? 0) + (workspace?.width ?? 0)).toBeLessThanOrEqual(391);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('git-row-unmerged').first()).toBeVisible();
  await page.getByTestId('git-row-unmerged').first().click();
  await expect(page.getByTestId('git-file-preview-status')).toContainText(
    'Unresolved conflict · File preview',
  );
  await expect(page.getByTestId('git-file-preview-message')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /commit|stage|push|pull|checkout|discard|\bmerge\b/i }),
  ).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 390x844 the long untracked preview stayed keyboard-focused, ' +
      'scrolled inside its own body with Capsule clearance, and kept the Workspace within 390px; ' +
      'at 1440x900 the conflict preview stayed identified and no write/merge control appeared',
  });
});
