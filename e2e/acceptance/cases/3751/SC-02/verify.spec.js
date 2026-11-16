'use strict';
// #3751 SC-02: an older page is held for one target; the first page is
// refreshed and the newer first page resolves before the old page. Releasing
// the old page must not append its commits or roll back the cursor, end flag or
// loading state. A normal unchanged-generation Load older still appends once and
// advances the cursor to the refreshed page's continuation.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

async function openHistory(page) {
  await page.goto('/#/fixture/workspace?capability=git&git=history-overlap');
  await expect(page.getByTestId('git-change-list')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByTestId('git-commit-row')).toHaveCount(50);
  await page.waitForFunction(() => window.fixtureGitHistoryOverlap);
}

test('SC-02: a refreshed first page owns the continuation, and stale older pages cannot publish', async ({
  page,
}, testInfo) => {
  // The Case process has a 120s cap; fail fast with a diagnostic instead of
  // waiting for a missing control until that cap kills the verifier.
  test.setTimeout(100_000);
  page.setDefaultTimeout(15_000);
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHistory(page);

  const loadOlder = page.getByTestId('git-history-load-more');
  await expect(loadOlder).toHaveText('Load older commits');

  // Hold the first page's continuation.
  await loadOlder.click();
  await expect
    .poll(() => page.evaluate(() => window.fixtureGitHistoryOverlap.olderRequests()))
    .toBe(1);
  await expect(loadOlder).toHaveText('Loading older commits…');

  // Refresh replaces the first page with generation 2 while that older page is
  // still in flight. The sr-only control is the History surface's real Refresh
  // affordance; clicking it directly avoids depending on its clipped geometry.
  await page
    .getByTestId('git-commit-list')
    .getByRole('button', { name: 'Refresh', exact: true })
    .evaluate((element) => element.click());
  await expect(
    page.getByText('A first page 2 commit 1', { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByTestId('git-commit-row')).toHaveCount(50);
  await expect(page.getByTestId('git-commit-row').filter({ hasText: /^A first page 1 / })).toHaveCount(0);
  await expect(loadOlder).toHaveText('Load older commits');
  await expect(loadOlder).toBeEnabled();
  expect(
    await page.evaluate(
      () => window.fixtureGitHistoryOverlap.firstPageRequests('devbox-01:fix-terminal-reconnect'),
    ),
  ).toBe(2);

  // Release the generation-one older page. It must not append, and its finally
  // must not rewrite the refreshed list's loading status.
  await page.evaluate(() => window.fixtureGitHistoryOverlap.releaseOlder());
  await expect
    .poll(() => page.evaluate(() => window.fixtureGitHistoryOverlap.olderSettled()))
    .toBe(true);
  await expect(
    page.getByText('A older page 1 commit 1', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId('git-commit-row').filter({ hasText: /^A first page 2 / })).toHaveCount(50);
  await expect(page.getByTestId('git-commit-row')).toHaveCount(50);
  await expect(loadOlder).toHaveText('Load older commits');
  await expect(loadOlder).toBeEnabled();

  // The unchanged generation continues normally once, from the refreshed
  // first page's cursor — not from the cursor the stale answer carried.
  await loadOlder.click();
  await expect(
    page.getByText('A older page 2 commit 1', { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText('A older page 1 commit 1', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId('git-commit-row')).toHaveCount(100);
  await expect(page.getByTestId('git-history-load-more')).toHaveCount(0);
  await expect(page.getByTestId('git-history-more')).toContainText('End of history');

  testInfo.annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: the History list held generation 1\'s older page, ' +
      'Refresh published generation 2\'s first page (50 rows, Load older enabled and not loading), ' +
      'releasing the held page appended nothing and changed no cursor/end/loading state, and a ' +
      'normal Load older then appended generation 2\'s 50 older rows exactly once and ended the log',
  });
});
