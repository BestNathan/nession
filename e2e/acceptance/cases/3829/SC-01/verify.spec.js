'use strict';
// #3829 SC-01: the App Claude surface opens directly on the bound/current
// conversation under the Nession-owned App header, with no wrapped multi-tab
// navigation, and opening it does not unmount the Terminal.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-01: Claude App opens on the bound conversation under one App header', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-01');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-layer-root').waitFor({ timeout: 30_000 });
  await page.locator('.xterm').first().waitFor({ timeout: 30_000 });
  await page
    .locator('.xterm')
    .first()
    .evaluate((element) => element.setAttribute('data-3829-terminal', 'original'));

  await page.getByTestId('app-header-workspace').first().click();
  await page.getByTestId('workspace-tool-claude-code').click({ timeout: 30_000 });
  await page.getByTestId('claude-code-app-workspace').waitFor({ timeout: 30_000 });

  const conversation = page.getByTestId('conversation-open');
  await expect(conversation).toBeVisible({ timeout: 30_000 });
  // The readable title comes from the provider's read response, not from a
  // UUID; the id must not become the page's content.
  await expect(conversation).toContainText('Terminal ownership handoff');
  await expect(conversation).not.toContainText('c0a1b2c3-');
  await expect(
    page.getByText('Read-only view. Continue this conversation in the Terminal.'),
  ).toBeVisible();

  // No permanent five-tab strip and exactly one host header.
  await expect(page.getByTestId('claude-code-view-tabs')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByTestId('app-page-header')).toHaveCount(1);
  await expect(page.getByTestId('app-page-header')).toContainText('Claude Code');
  await expect(page.getByTestId('app-page-action-browse')).toHaveAccessibleName('Browse Claude');

  // Terminal continuity: the Workspace is a layer; the Terminal stays mounted.
  await expect(page.getByTestId('app-layer-terminal')).toHaveCount(1);
  await expect(page.locator('.xterm[data-3829-terminal="original"]')).toHaveCount(1);

  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('app-layer-terminal')).toBeVisible();
  await expect(page.locator('.xterm[data-3829-terminal="original"]')).toHaveCount(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 390x844 the App Claude root rendered the bound ' +
      'conversation ("Terminal ownership handoff", no UUID), no tab strip and one ' +
      'app-page-header with the Browse action; the Terminal layer and its original ' +
      'xterm instance were still mounted while Workspace was open and after Back.',
  });
});
