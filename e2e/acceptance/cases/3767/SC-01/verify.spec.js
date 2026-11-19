'use strict';
// #3767 SC-01: a History selection belongs to the Git target it was made in.
// With an A commit and one of its files selected, the Workspace moves to
// Session B. B's first page resolves; no A row may remain current, no detail or
// diff pane may survive, and the fixture must never receive a `git.commit` or
// `git.diff` addressed to B that names A's OID. Selecting a B commit afterwards
// works normally and names B's target.
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

test('SC-01: switching Session leaves no predecessor selection, detail, or request', async ({
  page,
}, testInfo) => {
  // The Case process has a 120s cap; fail fast with a diagnostic instead of
  // waiting for a missing control until that cap kills the verifier.
  test.setTimeout(100_000);
  page.setDefaultTimeout(15_000);
  const { sha } = verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHistory(page);

  // A commit and one of its changed files are the selection under test.
  const rowA = commitRow(page, 'A first page 1 commit 1');
  await rowA.click();
  const aOid = await rowA.getAttribute('data-hash');
  expect(aOid).toMatch(/^[0-9a-f]{40}$/);
  await expect(rowA).toHaveAttribute('aria-current', 'true');
  await expect(detailSubject(page)).toHaveText('A first page 1 commit 1');

  const fileA = page.getByTestId('git-commit-file-row').first();
  await expect(fileA).toBeVisible();
  const aPath = await fileA.getAttribute('data-path');
  await fileA.click();
  await expect(page.getByTestId('git-diff-patch')).toBeVisible();

  // The reads that produced the pane are A's, and they name A's target, OID
  // and path — the positive control for the negative assertions below.
  await expect
    .poll(() => page.evaluate(() => window.fixtureGitHistoryOverlap.commitRequests().length))
    .toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.fixtureGitHistoryOverlap.diffRequests().length))
    .toBe(1);
  expect(await page.evaluate(() => window.fixtureGitHistoryOverlap.commitRequests())).toEqual([
    { agent_id: 'devbox-01', session: SESSION_A, oid: aOid },
  ]);
  expect(await page.evaluate(() => window.fixtureGitHistoryOverlap.diffRequests())).toEqual([
    { agent_id: 'devbox-01', session: SESSION_A, oid: aOid, path: aPath },
  ]);

  // Move to Session B while A's selection is on screen; B's first page
  // establishes B's list.
  await page.waitForFunction(() => typeof window.fixtureGitSelectSession === 'function');
  await page.evaluate((id) => window.fixtureGitSelectSession(id), SESSION_B);
  await expect
    .poll(() => page.evaluate(() => window.fixtureGitSelectedSession()))
    .toBe(SESSION_B);
  await expect(
    page.getByTestId('git-commit-row').filter({ hasText: /^B first page 1 / }),
  ).toHaveCount(50);

  // The predecessor's selection, detail and diff are gone.
  await expect(page.getByTestId('git-commit-detail')).toHaveCount(0);
  await expect(page.getByTestId('git-commit-empty')).toBeVisible();
  await expect(page.getByTestId('git-diff')).toHaveCount(0);
  await expect(page.getByTestId('git-diff-patch')).toHaveCount(0);
  await expect(
    page.getByTestId('git-commit-list').locator('[aria-current="true"]'),
  ).toHaveCount(0);

  // Negative control: the successor was never asked about A's OID, by detail
  // or diff, and resolving B's history added no read at all.
  const afterSwitch = await page.evaluate(() => ({
    commits: window.fixtureGitHistoryOverlap.commitRequests(),
    diffs: window.fixtureGitHistoryOverlap.diffRequests(),
  }));
  expect(afterSwitch.commits).toEqual([
    { agent_id: 'devbox-01', session: SESSION_A, oid: aOid },
  ]);
  expect(afterSwitch.diffs).toEqual([
    { agent_id: 'devbox-01', session: SESSION_A, oid: aOid, path: aPath },
  ]);
  expect(
    afterSwitch.commits.filter((request) => request.session === SESSION_B && request.oid === aOid),
  ).toHaveLength(0);
  expect(
    afterSwitch.diffs.filter((request) => request.session === SESSION_B && request.oid === aOid),
  ).toHaveLength(0);

  // A B commit selects normally, and its detail read names B and B's OID.
  const rowB = commitRow(page, 'B first page 1 commit 2');
  await rowB.click();
  const bOid = await rowB.getAttribute('data-hash');
  expect(bOid).toMatch(/^[0-9a-f]{40}$/);
  await expect(rowB).toHaveAttribute('aria-current', 'true');
  await expect(detailSubject(page)).toHaveText('B first page 1 commit 2');
  const finalCommitRequests = await page.evaluate(() =>
    window.fixtureGitHistoryOverlap.commitRequests(),
  );
  expect(finalCommitRequests).toHaveLength(2);
  expect(finalCommitRequests[1]).toEqual({
    agent_id: 'devbox-01',
    session: SESSION_B,
    oid: bOid,
  });

  testInfo.annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: selected A first-page commit ' + aOid +
      ' and file ' + aPath + ', moved the Workspace to Session B, B\'s first page listed 50 B ' +
      'rows with no current row, no commit detail and no diff pane; the fixture request log ' +
      'stayed exactly one A-target detail read and one A-target diff read, with no B-target ' +
      'request naming A\'s OID, and selecting B commit ' + bOid + ' then issued a B-target detail read',
  });
});
