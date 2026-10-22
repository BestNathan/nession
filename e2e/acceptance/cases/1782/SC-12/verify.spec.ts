// #1782 SC-12: end-to-end browser coverage for the standalone Pages origin:
// key views, deep-link refresh, responsive layout, safe text rendering and
// canonical source links. This reuses the shared standalone-Pages fixture that
// the regular pages-overview / pages-evidence regression specs run against.
import {test, expect} from '@playwright/test';
import {startPagesFixture} from '../../../../helpers/pagesStandalone';

const targetSha = process.env.NESSION_ACCEPTANCE_TARGET_SHA || '';

test.describe('Nession Pages parent acceptance', () => {
  let site: Awaited<ReturnType<typeof startPagesFixture>>;

  test.beforeAll(async () => {
    expect(targetSha).toMatch(/^[a-f0-9]{40}$/);
    site = await startPagesFixture();
  });

  test.afterAll(async () => {
    await site.close();
  });

  test('key views and deep-link refresh render the exact source snapshot', async ({page}) => {
    await page.setViewportSize({width: 1280, height: 900});

    await page.goto(site.origin + '/#/');
    await expect(page.getByRole('heading', {name: /An open space/})).toBeVisible();

    await page.goto(site.origin + '/#/agents');
    await expect(page.getByRole('heading', {name: 'The agents behind the work.'})).toBeVisible();
    await expect(page.getByText('Cost in USD')).toBeVisible();
    await expect(page.getByText('Unobserved', {exact: true})).toBeVisible();

    await page.goto(site.origin + '/#/work');
    await expect(page.getByRole('heading', {name: 'Work in progress.'})).toBeVisible();

    await page.goto(site.origin + '/#/repository');
    await expect(page.getByRole('heading', {name: 'Built in the open.'})).toBeVisible();
    await expect(page.getByText('Repository metrics source: stale', {exact: false})).toBeVisible();

    await page.goto(site.origin + '/#/evidence');
    await expect(page.getByRole('heading', {name: 'Evidence, not claims.'})).toBeVisible();
    await expect(page.getByText('Integrity: not independently verified by this public site').first()).toBeVisible();

    // A deep link is a first-class route: a hard refresh must not fall back to
    // the home view or lose the exact-source evidence panel.
    await page.goto(site.origin + '/#/work/issue/1782');
    await expect(page.getByRole('heading', {name: 'Source-bound per-ID E2E receipts'})).toBeVisible();
    await expect(page.getByText('Trusted Acceptance SC: Unknown / Not independently observed.')).toBeVisible();
    await expect(page.getByText('Implementing PR / logical Slice: Unknown / Unlinked')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', {name: 'Source-bound per-ID E2E receipts'})).toBeVisible();
    await expect(page.getByText('Trusted Acceptance SC: Unknown / Not independently observed.')).toBeVisible();

    await page.goto(site.origin + '/#/work/pr/1787');
    await expect(page.getByText('Issue implementation/Agent Slice: Unknown / Unlinked')).toBeVisible();
    await expect(page.getByRole('link', {name: /Quality · success · Run 42 \/ attempt 1/})).toHaveAttribute(
      'href', 'https://github.com/BestNathan/nession/actions/runs/42');
  });

  test('source deep links are canonical and exact-evidence bound', async ({page}) => {
    await page.goto(site.origin + '/#/work/issue/1782');
    const overview = page.getByRole('link', {name: /pages-overview · Pass · Run 42 \/ attempt 1/});
    await expect(overview).toHaveAttribute('href', 'https://github.com/BestNathan/nession/actions/runs/42');
    await expect(page.getByRole('link', {name: /pages-evidence · Fail · Run 42 \/ attempt 1/})).toBeVisible();
    await expect(page.getByText('Evidence target SHA ' + 'a'.repeat(40) + ' · E2E only, not a Success Criterion verdict').first()).toBeVisible();
    // A PR cross-reference is a mention, never inferred ownership.
    await expect(page.getByText('GitHub cross-reference · PR #1787')).toBeVisible();
    await expect(page.getByText('A GitHub cross-reference is NOT verified implementing PR ownership or Agent causality.')).toBeVisible();
  });

  test('malicious Issue text renders as inert text, never as markup', async ({page}) => {
    await page.goto(site.origin + '/#/work');
    await expect(page.getByText('<img src=x onerror=alert(1)>', {exact: false}).first()).toBeVisible();
    expect(await page.locator('img').count()).toBe(0);

    await page.goto(site.origin + '/#/work/issue/1782');
    await expect(page.getByRole('heading', {level: 1})).toContainText('<img src=x onerror=alert(1)>');
    expect(await page.locator('img').count()).toBe(0);
    await expect(page.locator('script').filter({hasText: 'alert(1)'})).toHaveCount(0);
  });

  test('mobile layout keeps the deep-linked evidence readable without horizontal overflow', async ({page}) => {
    await page.setViewportSize({width: 390, height: 844});
    await page.goto(site.origin + '/#/work/pr/1787');
    await expect(page.getByText('Issue implementation/Agent Slice: Unknown / Unlinked')).toBeVisible();
    await expect(page.getByRole('link', {name: /Review event changes requested/})).toBeVisible();

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
