'use strict';
// #3767 SC-02: a selection only exists while its row does. With an A commit and
// one of its files selected, Refresh replaces the first page with a generation
// that no longer contains that commit. The orphaned detail and file selection
// must disappear, the replacement must not re-read the dropped OID, and
// ordinary selection and paging in the refreshed generation must still work —
// including selecting a commit from an older page and keeping a selection while
// a continuation appends.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const SESSION_A = 'devbox-01:fix-terminal-reconnect';

async function openHistory(page) {
  await page.goto('/#/fixture/workspace?capability=git&git=history-overlap');
  await expect(page.getByTestId('git-change-list')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByTestId('git-commit-row')).toHaveCount(50);
  await page.waitForFunction(() => window.fixtureGitHistoryOverlap);
}

/** The row whose own subject is exactly `subject`, not a longer neighbour. */
function commitRow(page, subject) {
  return page
    .getByTestId('git-commit-row')
    .filter({ has: page.getByText(subject, { exact: true }) });
}

/** The detail pane's subject line, independent of body/date content. */
function detailSubject(page) {
  return page.getByTestId('git-commit-detail').locator('p').first();
}

test('SC-02: a refreshed first page drops an orphaned commit and file selection', async ({
  page,
}, testInfo) => {
  // The Case process has a 120s cap; fail fast with a diagnostic instead of
  // waiting for a missing control until that cap kills the verifier.
  test.setTimeout(100_000);
  page.setDefaultTimeout(15_000);
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHistory(page);

  // Select a generation-one commit and one of its changed files.
  const rowGen1 = commitRow(page, 'A first page 1 commit 1');
  await rowGen1.click();
  const droppedOid = await rowGen1.getAttribute('data-hash');
  expect(droppedOid).toMatch(/^[0-9a-f]{40}$/);
  await expect(rowGen1).toHaveAttribute('aria-current', 'true');
  await expect(detailSubject(page)).toHaveText('A first page 1 commit 1');
  const file = page.getByTestId('git-commit-file-row').first();
  await expect(file).toBeVisible();
  await file.click();
  await expect(page.getByTestId('git-diff-patch')).toBeVisible();

  await expect
    .poll(() => page.evaluate(() => window.fixtureGitHistoryOverlap.commitRequests().length))
    .toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.fixtureGitHistoryOverlap.diffRequests().length))
    .toBe(1);

  // Refresh replaces the first page with generation two, which does not
  // contain the selected commit. The sr-only control is the History surface's
  // real Refresh affordance; clicking it directly avoids its clipped geometry.
  await page
    .getByTestId('git-commit-list')
    .getByRole('button', { name: 'Refresh', exact: true })
    .evaluate((element) => element.click());
  await expect(
    page.getByTestId('git-commit-row').filter({ hasText: /^A first page 2 / }),
  ).toHaveCount(50);
  await expect(
    page.getByTestId('git-commit-row').filter({ hasText: /^A first page 1 / }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => window.fixtureGitHistoryOverlap.firstPageRequests('devbox-01:fix-terminal-reconnect'),
    ),
  ).toBe(2);

  // The row the detail belonged to is gone, so the detail, the file selection
  // and the diff pane are gone with it, and no row is current.
  await expect(page.getByTestId('git-commit-detail')).toHaveCount(0);
  await expect(page.getByTestId('git-commit-empty')).toBeVisible();
  await expect(page.getByTestId('git-diff')).toHaveCount(0);
  await expect(page.getByTestId('git-diff-patch')).toHaveCount(0);
  await expect(
    page.getByTestId('git-commit-list').locator('[aria-current="true"]'),
  ).toHaveCount(0);

  // The replacement did not ask for the dropped commit again, by detail or by
  // diff: the reads are still exactly the two that built the pane A once had.
  const afterRefresh = await page.evaluate(() => ({
    commits: window.fixtureGitHistoryOverlap.commitRequests(),
    diffs: window.fixtureGitHistoryOverlap.diffRequests(),
  }));
  expect(afterRefresh.commits).toHaveLength(1);
  expect(afterRefresh.commits[0]).toEqual({
    agent_id: 'devbox-01',
    session: SESSION_A,
    oid: droppedOid,
  });
  expect(afterRefresh.diffs).toHaveLength(1);

  // Ordinary selection and paging stay usable in the refreshed generation.
  // Selecting a refreshed commit survives loading an older page...
  const rowGen2 = commitRow(page, 'A first page 2 commit 2');
  await rowGen2.click();
  await expect(rowGen2).toHaveAttribute('aria-current', 'true');
  await expect(detailSubject(page)).toHaveText('A first page 2 commit 2');

  await page.getByTestId('git-history-load-more').click();
  // The history-overlap fixture holds the first older page so #3751's Case can
  // release it after a replacement; this Case releases it too, and the answer
  // is the page the refreshed cursor names.
  await expect
    .poll(() => page.evaluate(() => window.fixtureGitHistoryOverlap.olderRequests()))
    .toBe(1);
  await page.evaluate(() => window.fixtureGitHistoryOverlap.releaseOlder());
  await expect(
    page.getByTestId('git-commit-row').filter({ hasText: /^A older page 2 / }),
  ).toHaveCount(50);
  await expect(rowGen2).toHaveAttribute('aria-current', 'true');
  await expect(detailSubject(page)).toHaveText('A first page 2 commit 2');

  // ...and a commit that exists only in the appended older page is selectable.
  const rowOlder = commitRow(page, 'A older page 2 commit 1');
  await rowOlder.click();
  const olderOid = await rowOlder.getAttribute('data-hash');
  await expect(rowOlder).toHaveAttribute('aria-current', 'true');
  await expect(detailSubject(page)).toHaveText('A older page 2 commit 1');
  expect(
    await page.evaluate(
      () => window.fixtureGitHistoryOverlap.commitRequests().length,
    ),
  ).toBe(3);

  testInfo.annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: selected generation-one commit ' + droppedOid +
      ' and its file, Refresh published the 50-row generation-two first page with no current ' +
      'row, no commit detail and no diff pane, the request log still held exactly the two ' +
      'generation-one reads (no re-read of the dropped OID), selecting generation-two commit ' +
      'was retained while loading 50 older rows, and older-page commit ' + olderOid +
      ' then selected and resolved normally',
  });
});
