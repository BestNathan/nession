'use strict';
// #3751 SC-01: A's older page is held; the Workspace moves to Session B and
// B's first page establishes B's list before A's answer is released. B's
// commit rows, cursor, end-of-history flag and loading state must be unchanged,
// and A's older commit must never become a selectable row in B — including
// when B's own continuation is loaded afterwards from B's cursor.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const SESSION_A = 'devbox-01:fix-terminal-reconnect';
const SESSION_B = 'devbox-01:design-system';

async function openHistory(page) {
  await page.goto('/#/fixture/workspace?capability=git&git=history-overlap');
  await expect(page.getByTestId('git-change-list')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByTestId('git-commit-row')).toHaveCount(50);
  await page.waitForFunction(() => window.fixtureGitHistoryOverlap);
}

async function selectSession(page, sessionId) {
  await page.waitForFunction(() => typeof window.fixtureGitSelectSession === 'function');
  await page.evaluate((id) => window.fixtureGitSelectSession(id), sessionId);
  await expect
    .poll(() => page.evaluate(() => window.fixtureGitSelectedSession()))
    .toBe(sessionId);
}

test('SC-01: A held older page released after switching to B leaves B unchanged', async ({
  page,
}, testInfo) => {
  // The Case process has a 120s cap; fail fast with a diagnostic instead of
  // waiting for a missing control until that cap kills the verifier.
  test.setTimeout(100_000);
  page.setDefaultTimeout(15_000);
  const { sha } = verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHistory(page);

  // A's first page and its continuation boundary.
  await expect(
    page.getByText('A first page 1 commit 1', { exact: true }),
  ).toHaveCount(1);
  const loadOlder = page.getByTestId('git-history-load-more');
  await expect(loadOlder).toHaveText('Load older commits');
  await expect(loadOlder).toBeEnabled();

  // Hold A's older page. The request reached the fixture; nothing applied.
  await loadOlder.click();
  await expect
    .poll(() => page.evaluate(() => window.fixtureGitHistoryOverlap.olderRequests()))
    .toBe(1);
  await expect(loadOlder).toHaveText('Loading older commits…');

  // Move to B while A's older page is still in flight. B's first page
  // establishes B's list and its cursor.
  await selectSession(page, SESSION_B);
  await expect(
    page.getByText('B first page 1 commit 1', { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByTestId('git-commit-row')).toHaveCount(50);
  await expect(page.getByTestId('git-commit-row').filter({ hasText: /^A / })).toHaveCount(0);
  await expect(loadOlder).toHaveText('Load older commits');
  await expect(loadOlder).toBeEnabled();

  // Release A's older page. It belongs to A's list, which is gone.
  await page.evaluate(() => window.fixtureGitHistoryOverlap.releaseOlder());
  await expect
    .poll(() => page.evaluate(() => window.fixtureGitHistoryOverlap.olderSettled()))
    .toBe(true);

  await expect(
    page.getByText('A older page 1 commit 1', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId('git-commit-row')).toHaveCount(50);
  await expect(page.getByTestId('git-commit-row').filter({ hasText: /^B / })).toHaveCount(50);
  await expect(loadOlder).toHaveText('Load older commits');
  await expect(loadOlder).toBeEnabled();

  // B's own continuation starts from B's cursor: the stale answer neither
  // appended commits nor rolled the continuation boundary back.
  await loadOlder.click();
  await expect(
    page.getByText('B older page 1 commit 1', { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByTestId('git-commit-row')).toHaveCount(100);
  await expect(page.getByTestId('git-commit-row').filter({ hasText: /^A / })).toHaveCount(0);

  testInfo.annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: A\'s older History page was held (first page 50 rows, ' +
      'cursor A), the Workspace moved to Session B, B\'s first page (50 B rows) resolved, ' +
      'releasing A\'s answer left exactly B\'s 50 rows with the Load older control enabled and not ' +
      'loading, and B\'s continuation appended B\'s older rows from B\'s cursor with no A row ' +
      'ever rendered',
  });
});
