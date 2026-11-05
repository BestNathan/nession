'use strict';
// #2787 SC-03: the real Git Workspace Changes surface demonstrates
//   status A in flight → manual Refresh → B resolves → A resolves → still B.
// The fixture supplies the controlled git request: the mount read is held
// until the Case releases it, and the manual Refresh answers with the newer
// repository state. The surface must never regress to the older answer, and it
// must issue exactly the two reads (no polling, no write capability).
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-03: a late older status read cannot overwrite a manual Refresh', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-03');

  await page.goto('/#/fixture/workspace?capability=git&git=overlap');
  await expect(page.getByTestId('git-workspace')).toBeVisible({ timeout: 20_000 });
  // The mount read is in flight. The manual recovery path stays available,
  // which is what makes this user sequence possible at all.
  await expect(page.getByTestId('git-refresh')).toBeEnabled();

  // R2: the manual read answers first with the newer repository state.
  await page.getByTestId('git-refresh').click();
  await expect(page.getByTestId('git-branch')).toHaveText('feat/repo-status', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('git-change-list')).toBeVisible();

  // R1: the older mount read resolves after R2 already published.
  await page.evaluate(() => window.fixtureGitOverlap.releaseOlder());
  await page.waitForFunction(() => window.fixtureGitOverlap?.olderSettled === true);

  // The surface still presents R2's repository, not the older clean tree.
  await expect(page.getByTestId('git-branch')).toHaveText('feat/repo-status');
  await expect(page.getByTestId('git-change-list')).toBeVisible();
  await expect(page.getByTestId('git-clean')).toHaveCount(0);

  const requests = await page.evaluate(() => window.fixtureGitOverlap.requests);
  expect(requests, 'mount read + manual Refresh, with no polling').toBe(2);
  // Refresh is a read affordance: there is still no write control.
  await expect(
    page.getByRole('button', { name: /commit|stage|push|pull|checkout|discard/i }),
  ).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Git Workspace Changes at the fixture route held the ' +
      'mount status read (older clean tree) in flight, a manual Refresh published ' +
      'feat/repo-status first, and releasing the older read left the view on ' +
      'feat/repo-status with its change list; exactly 2 status reads and no write control',
  });
});
