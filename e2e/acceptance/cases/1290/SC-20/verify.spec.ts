// #1290 SC-20: real Chromium acceptance of the GitHub depth inside the Git
// Workspace, using the deterministic fixture provider on the canonical route.
import { expect, test } from '@playwright/test';

async function gotoGithub(page: import('@playwright/test').Page, scenario = 'resolved') {
  await page.goto(`/#/fixture/workspace?capability=git&github=${scenario}`);
  await page.getByTestId('git-workspace').waitFor();
  await page.getByTestId('git-surface-github').click();
  await page.getByTestId('github-repository').waitFor();
}

test('desktop: independent list/reader, Focus reading and safe lazy detail', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoGithub(page);
  await expect(page.getByTestId('github-issue-row-1290')).toBeVisible();
  const list = page.getByTestId('github-issue-list-scroll');
  const reader = page.getByTestId('github-issue-reader-scroll');
  expect(await list.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  expect(await reader.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  await page.getByTestId('github-issue-row-1290').click();
  await expect(page.getByTestId('github-issue-detail-1290')).toContainText('Fixture Issue');
  await expect(page.getByTestId('github-issue-detail-1290').locator('script')).toHaveCount(0);
  await page.getByTestId('github-focus-reading').click();
  await expect(page.getByTestId('github-issue-list')).toBeHidden();
  await expect(page.getByTestId('github-issue-detail-1290')).toBeVisible();
});

test('mobile: list → detail → Back keeps filter, search, scroll and selection', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoGithub(page);
  await page.getByTestId('github-filter-all').click();
  await page.getByTestId('github-issues-search').fill('session');
  await expect(page.getByTestId('github-issue-row-2514')).toBeVisible();
  const list = page.getByTestId('github-issue-list-scroll');
  await page.getByTestId('github-issue-row-2514').click();
  await expect(page.getByTestId('github-issue-detail-2514')).toBeVisible();
  await page.getByTestId('github-back-to-list').click();
  await expect(page.getByTestId('github-issues-search')).toHaveValue('session');
  await expect(page.getByTestId('github-filter-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('github-issue-row-2514')).toHaveAttribute('aria-current', 'true');
  expect(await list.evaluate((element) => element.isConnected)).toBe(true);
});

test('unavailable/auth/fork states and absence of mutation controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoGithub(page, 'unauthenticated');
  await expect(page.getByTestId('github-auth-unavailable')).toContainText('GITHUB_TOKEN');
  await gotoGithub(page, 'no-remote');
  await expect(page.getByTestId('github-no-remote')).toContainText('Local Repository remains available');
  await gotoGithub(page, 'fork');
  await expect(page.getByTestId('github-remote-select').locator('option')).toHaveCount(2);
  await page.getByTestId('github-issue-row-1290').click();
  await page.getByTestId('github-issue-detail-1290').waitFor();
  const labels = await page.getByRole('button').allTextContents();
  for (const forbidden of ['New issue', 'Comment', 'Merge', 'Dispatch']) {
    expect(labels.join('|')).not.toContain(forbidden);
  }
});
