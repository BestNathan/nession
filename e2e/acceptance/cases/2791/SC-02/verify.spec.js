'use strict';
// #2791 SC-02: every non-ordinary diff answer is visible and honest. Binary,
// empty and mode-only files are named; truncation reports the real omitted
// bytes; malformed output keeps a labelled raw fallback instead of a blank or
// falsely complete pane.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-02: binary, empty, mode-only, truncated and malformed patches stay honest', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=git&git=diff-states');
  await page.getByTestId('git-change-list').waitFor();

  const row = (path) => page.getByTestId('git-row-tracked').filter({ hasText: path });
  const patch = page.getByTestId('git-diff-patch').locator('diffs-container');

  await row('assets/logo.png').click();
  await expect(page.getByTestId('git-diff-binary')).toContainText('Binary file');
  await expect(page.getByTestId('git-diff-patch')).toHaveCount(0);

  await row('src/empty.txt').click();
  await expect(page.getByTestId('git-diff-no-changes')).toContainText('No changes to show');
  await expect(page.getByTestId('git-diff-patch')).toHaveCount(0);

  await row('mode/run.sh').click();
  const mode = page.getByTestId('git-diff-mode-only');
  await expect(mode).toContainText('100644');
  await expect(mode).toContainText('100755');
  await expect(mode).toContainText('No line changes');
  await expect(page.getByTestId('git-diff-patch')).toHaveCount(0);

  await row('src/large.ts').click();
  await expect(page.getByTestId('git-diff-truncated')).toContainText('4.0 KB');
  await expect(patch.locator('pre[data-diff]')).toBeVisible();
  await expect(patch.locator('[data-line][data-line-type="change-addition"]')).toHaveCount(2);

  await row('src/malformed.ts').click();
  await expect(page.getByTestId('git-diff-fallback')).toBeVisible();
  await expect(page.getByTestId('git-diff-fallback-note')).toContainText(
    'Could not render this diff. Showing the raw patch.',
  );
  await expect(page.getByTestId('git-diff-raw')).toContainText('@@ -1,2 +1,2 @@');
  await expect(page.getByTestId('git-diff-raw')).toContainText('+const after = 2;');
  // Nothing was invented from the rejected patch.
  await expect(page.getByTestId('git-diff-patch')).toHaveCount(0);
  await expect(patch.locator('[data-line][data-line-type="change-addition"]')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': binary named with no patch body; empty named with no pane; ' +
      'mode-only named 100644→100755 with no lines; truncated patch rendered with ' +
      '[Diff truncated: 4.0 KB ...]; malformed patch showed the labelled raw fallback ' +
      'with no invented diff rows',
  });
});
