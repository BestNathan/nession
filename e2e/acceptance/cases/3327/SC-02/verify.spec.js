'use strict';
// #3327 SC-02: in the real rendered Git Workspace, a stage request on Session A
// is held; the user switches to B and sees B's repository; releasing A's
// success leaves B's branch, file list, commit draft and controls unchanged;
// switching back to A recovers A's authoritative post-state.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const SESSION_A = 'devbox-01:fix-terminal-reconnect';
const SESSION_B = 'devbox-01:design-system';

async function openMutationOverlap(page) {
  await page.goto('/#/fixture/workspace?capability=git&git=mutation-overlap');
  await expect(page.getByTestId('git-change-list')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => window.fixtureGitMutationOverlap);
}

async function selectSession(page, sessionId) {
  await page.waitForFunction(() => typeof window.fixtureGitSelectSession === 'function');
  await page.evaluate((id) => window.fixtureGitSelectSession(id), sessionId);
  await expect
    .poll(() => page.evaluate(() => window.fixtureGitSelectedSession()))
    .toBe(sessionId);
}

test('SC-02: A held stage released after switching to B leaves B unchanged, and A recovers', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMutationOverlap(page);

  // The default Session is A: its repository is repo-a.
  await expect(page.getByTestId('git-branch')).toHaveText('feat/a');
  const aRow = page.getByTestId('git-row-unstaged').filter({ hasText: 'a.ts' });
  await expect(aRow).toHaveCount(1);

  // Hold A's stage response. The request reached the fixture; nothing applied.
  await aRow.getByTestId('git-stage').click();
  await expect.poll(() => page.evaluate(() => window.fixtureGitMutationOverlap.requests())).toBe(1);
  await expect(page.getByTestId('git-row-unstaged').filter({ hasText: 'a.ts' })).toHaveCount(1);

  // Move to B: a different repository, branch, file list and commit draft.
  await selectSession(page, SESSION_B);
  await expect(page.getByTestId('git-branch')).toHaveText('feat/b');
  const bRow = page.getByTestId('git-row-unstaged').filter({ hasText: 'b.ts' });
  await expect(bRow).toHaveCount(1);
  await expect(page.getByTestId('git-row-unstaged').filter({ hasText: 'a.ts' })).toHaveCount(0);
  await page.getByTestId('git-commit-message').fill('draft for B');

  // Release A's success. The mounted view must still be B's.
  await page.evaluate(() => window.fixtureGitMutationOverlap.release(false));
  await expect.poll(() => page.evaluate(() => window.fixtureGitMutationOverlap.settled())).toBe(true);
  await expect(page.getByTestId('git-branch')).toHaveText('feat/b');
  await expect(page.getByTestId('git-row-unstaged').filter({ hasText: 'a.ts' })).toHaveCount(0);
  await expect(bRow).toHaveCount(1);
  await expect(page.getByTestId('git-commit-message')).toHaveValue('draft for B');
  await expect(page.getByTestId('git-mutation-notice')).toHaveCount(0);
  await expect(bRow.getByTestId('git-stage')).toBeEnabled();

  // B's own mutation still adopts its authoritative post-state.
  await bRow.getByTestId('git-stage').click();
  await expect(page.getByTestId('git-row-staged').filter({ hasText: 'b.ts' })).toHaveCount(1);
  await expect(page.getByTestId('git-branch')).toHaveText('feat/b');

  // Back to A: the held stage's authoritative post-state is visible.
  await selectSession(page, SESSION_A);
  await expect(page.getByTestId('git-branch')).toHaveText('feat/a');
  await expect(page.getByTestId('git-row-staged').filter({ hasText: 'a.ts' })).toHaveCount(1);
  await expect(page.getByTestId('git-row-unstaged').filter({ hasText: 'a.ts' })).toHaveCount(0);

  testInfo.annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: a git.stage on Session A was held, the Workspace ' +
      'moved to Session B (feat/b, b.ts, draft "draft for B"), releasing A\'s success left ' +
      'B\'s branch, rows, draft, notice and stage control unchanged, B\'s own stage adopted its ' +
      'post-state, and moving back to A showed a.ts staged',
  });
});
