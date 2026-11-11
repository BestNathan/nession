// e2e/tests/browser/git-github-context.spec.ts
//
// #1290 SC-14/15/20/23: the Git capability presents Repository and GitHub as
// one capability, direct Capsule → Git Workspace entry (no Git Peek), lazy
// Issues/PR detail with independent scroll, the mobile list → detail → Back
// state preservation, Actions run scope and the absence of mutation controls.
// The GitHub answers come from the deterministic fixture provider; this is a
// browser acceptance of the production surface, not a live GitHub integration.
import { expect, test, type Page } from '@playwright/test';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

const counts = (page: Page) =>
  page.evaluate(() => (window as Window & {
    fixtureGithubRequests?: Record<string, number>;
  }).fixtureGithubRequests);

async function gotoGithub(page: Page, scenario = 'resolved') {
  await page.goto(`/#/fixture/workspace?capability=git&github=${scenario}`);
  await page.getByTestId('git-workspace').waitFor();
  await page.getByTestId('git-surface-github').click();
  await page.getByTestId('github-repository').waitFor();
}

test('Git is one capability: Repository and GitHub are grouped, and no Terminal Peek intervenes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture');
  await page.getByTestId('capsule-capability-more').click();
  // The legacy Git Terminal projection is not offered any more.
  await expect(page.getByTestId('capsule-capability-picker-git')).toHaveCount(0);

  await page.goto('/#/fixture/workspace');
  await page.getByTestId('workspace-tool-git').click();
  await expect(page.getByTestId('git-workspace')).toBeVisible();
  await expect(page.getByTestId('git-surface-repository')).toBeVisible();
  await expect(page.getByTestId('git-surface-github')).toBeVisible();
  await expect(page.getByTestId('capsule-capability-projection')).toHaveCount(0);
  // Repository and GitHub are two groups, not seven flat peer tabs.
  await expect(page.getByRole('tab', { name: 'Changes' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Issues' })).toHaveCount(0);
  await page.getByTestId('git-surface-github').click();
  await expect(page.getByRole('tab', { name: 'Issues' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Changes' })).toHaveCount(0);
});

test('Issues: bounded list, lazy full detail, safe Markdown and independent scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoGithub(page);
  await expect(page.getByTestId('github-repository')).toContainText(
    'github.com/fixture-owner/nession',
  );
  await expect(page.getByTestId('github-issue-row-1290')).toBeVisible();
  const before = await counts(page);
  expect(before?.issueDetail).toBe(0);

  // The list and the reader are separate scroll owners, not one page.
  const list = page.getByTestId('github-issue-list-scroll');
  const reader = page.getByTestId('github-issue-reader-scroll');
  expect(await list.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  expect(await reader.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  await list.evaluate((element) => { element.scrollTop = 48; });
  await reader.evaluate((element) => { element.scrollTop = 32; });
  expect(await list.evaluate((element) => element.scrollTop)).toBe(48);
  expect(await reader.evaluate((element) => element.scrollTop)).toBe(32);

  await page.getByTestId('github-issue-row-1290').click();
  await expect(page.getByTestId('github-issue-detail-1290')).toBeVisible();
  expect((await counts(page))?.issueDetail).toBe(1);
  await expect(page.getByTestId('github-issue-detail-1290')).toContainText('Fixture Issue');
  await expect(page.getByTestId('github-issue-detail-1290').locator('script')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as Window & { fixtureGithubInjected?: boolean }).fixtureGithubInjected),
  ).toBeUndefined();
  await expect(page.getByTestId('github-source-link')).toHaveAttribute(
    'href',
    'https://github.com/fixture-owner/nession/issues/1290',
  );

  // Focus reading collapses only the list; selection and content stay.
  await page.getByTestId('github-focus-reading').click();
  await expect(page.getByTestId('github-focus-reading')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('github-issue-list')).toBeHidden();
  await expect(page.getByTestId('github-issue-detail-1290')).toBeVisible();
  await page.getByTestId('github-focus-reading').click();
  await expect(page.getByTestId('github-issue-list')).toBeVisible();
});

test('Mobile: push detail and Back restore filtering, search, scroll and selection', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoGithub(page);
  await page.getByTestId('github-issue-row-1290').waitFor();

  await page.getByTestId('github-filter-all').click();
  await page.getByTestId('github-issues-search').fill('session');
  await page.getByTestId('github-issues-search').press('Enter');
  await expect(page.getByTestId('github-issue-row-2514')).toBeVisible();
  const list = page.getByTestId('github-issue-list-scroll');
  await list.evaluate((element) => { element.scrollTop = 96; });

  await page.getByTestId('github-issue-row-2514').click();
  await expect(page.getByTestId('github-issue-detail-2514')).toBeVisible();
  await expect(page.getByTestId('github-issue-list')).toBeHidden();

  await page.getByTestId('github-back-to-list').click();
  await expect(page.getByTestId('github-issue-list')).toBeVisible();
  await expect(page.getByTestId('github-issues-search')).toHaveValue('session');
  await expect(page.getByTestId('github-filter-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('github-issue-row-2514')).toHaveAttribute('aria-current', 'true');
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test('Pull Requests expose the exact current-branch relation and lazy detail', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoGithub(page);
  await page.getByTestId('github-tab-pull-requests').click();
  await expect(page.getByTestId('github-pr-relation')).toContainText('Current branch · PR #2229');
  const before = await counts(page);
  expect(before?.pullRequestDetail).toBe(0);
  await page.getByTestId('github-pr-row-2229').click();
  const detail = page.getByTestId('github-pr-detail-2229');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('fixture-owner:feature/git-github');
  await expect(detail).toContainText('→ main');
  expect((await counts(page))?.pullRequestDetail).toBe(1);
});

test('Actions keep queued, in-progress, completed and disabled distinct and expose run scope', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoGithub(page);
  await page.getByTestId('github-tab-actions').click();
  await expect(page.getByTestId('github-workflow-status-1')).toContainText('Completed · success');
  await expect(page.getByTestId('github-workflow-status-2')).toContainText('Queued');
  await expect(page.getByTestId('github-workflow-status-3')).toContainText('Disabled');
  await page.getByTestId('github-actions-scope-branch').click();
  await expect(page.getByTestId('github-actions-scope-label')).toContainText(
    'Latest run per workflow · feature/git-github',
  );
  await expect(page.getByTestId('github-workflow-status-1')).toContainText('In progress');
});

test('Hidden depths make no requests, and no interval polling starts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoGithub(page);
  await page.getByTestId('github-issue-row-1290').waitFor();
  let observed = await counts(page);
  expect(observed).toMatchObject({ repository: 1, issues: 1, pullRequests: 0, workflows: 0 });

  await page.getByTestId('github-tab-pull-requests').click();
  await page.getByTestId('github-pr-row-2229').waitFor();
  observed = await counts(page);
  expect(observed).toMatchObject({ issues: 1, pullRequests: 1, workflows: 0 });

  await page.getByTestId('github-tab-actions').click();
  await page.getByTestId('github-workflow-1').waitFor();
  observed = await counts(page);
  expect(observed).toMatchObject({ issues: 1, pullRequests: 1, workflows: 1 });

  await page.waitForTimeout(1200);
  const later = await counts(page);
  expect(later).toEqual(observed);

  // Returning to Repository does not ask GitHub for anything.
  await page.getByTestId('git-surface-repository').click();
  await page.waitForTimeout(300);
  expect(await counts(page)).toEqual(observed);
});

test('Unavailable states stay scoped and Local Repository remains usable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoGithub(page, 'unauthenticated');
  await expect(page.getByTestId('github-auth-unavailable')).toContainText('GITHUB_TOKEN');
  await page.getByTestId('git-surface-repository').click();
  await expect(page.getByTestId('git-change-list')).toBeVisible();

  await gotoGithub(page, 'ambiguous');
  await expect(page.getByTestId('github-ambiguous-remote')).toBeVisible();
  await expect(page.getByTestId('github-remote-choice-upstream')).toBeVisible();

  await gotoGithub(page, 'no-remote');
  await expect(page.getByTestId('github-no-remote')).toContainText('Local Repository remains available');

  await gotoGithub(page, 'rate-limited');
  await expect(page.getByTestId('github-repository-error')).toContainText('Retry after 30s');
});

test('A fork exposes only discovered remote choices and re-resolves the selection', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoGithub(page, 'fork');
  const select = page.getByTestId('github-remote-select');
  await expect(select).toBeVisible();
  await expect(select.locator('option')).toHaveCount(2);
  await expect(select.locator('option')).toContainText(['origin', 'upstream']);
  const before = await counts(page);
  await select.selectOption('upstream');
  await expect.poll(async () => (await counts(page))?.repository).toBe((before?.repository ?? 0) + 1);
});

test('No GitHub depth offers a mutation control', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoGithub(page);
  await page.getByTestId('github-issue-row-1290').click();
  await page.getByTestId('github-issue-detail-1290').waitFor();
  await page.getByTestId('github-tab-pull-requests').click();
  await page.getByTestId('github-pr-row-2229').click();
  await page.getByTestId('github-pr-detail-2229').waitFor();
  await page.getByTestId('github-tab-actions').click();
  await page.getByTestId('github-workflow-1').waitFor();

  const labels = await page.getByRole('button').allTextContents();
  for (const forbidden of ['New issue', 'Comment', 'Merge', 'Close', 'Dispatch', 'Re-run']) {
    expect(labels.join('|')).not.toContain(forbidden);
  }
  await expect(page.getByTestId('github-hosting').locator('textarea')).toHaveCount(0);
});
