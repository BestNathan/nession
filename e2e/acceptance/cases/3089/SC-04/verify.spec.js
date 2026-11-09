'use strict';
// #3089 SC-04: App Session creation is a full-height operation page with child
// Location/ENV depths, draft preservation, an anchored CTA and explicit
// offline/disabled state.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

async function noHorizontalOverflow(page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test('SC-04: non-Project create keeps the draft across child Agent and ENV depths', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app?operation=create-session');

  const createPage = page.getByTestId('app-create-session-page');
  await expect(createPage).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toHaveCount(1);
  const footerBox = await page.getByTestId('app-create-session-page-footer').boundingBox();
  expect(footerBox).not.toBeNull();
  expect(footerBox.y + footerBox.height).toBeCloseTo(844, 0);

  await createPage.locator('#name').fill('draft-session-name');
  await createPage.getByTestId('app-session-agent').click();
  await expect(page.getByTestId('app-create-agent-page')).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toHaveCount(1);
  await page.getByTestId('app-create-agent-0').click();
  await page.getByTestId('app-create-agent-done').click();
  await expect(createPage).toBeVisible();
  await expect(createPage.locator('#name')).toHaveValue('draft-session-name');

  await createPage.getByTestId('app-session-env').click();
  const envPage = page.getByTestId('app-create-env-page');
  await expect(envPage).toBeVisible();
  await envPage.locator('button').first().click();
  await page.getByTestId('app-create-env-done').click();
  await expect(createPage.locator('#name')).toHaveValue('draft-session-name');
  await expect(createPage.getByTestId('create-session-submit')).toBeEnabled();
  await noHorizontalOverflow(page);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 390 non-Project create was one-header full-height with anchored CTA; ' +
      'Agent and ENV were child depths and the typed Session name survived both',
  });
});

test('SC-04: Project create shows existing-location status and blocks an offline Agent', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app?projects=canonical');

  await page.getByTestId('app-header-sessions').click();
  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('project-detail-create-session').click();
  const createPage = page.getByTestId('app-create-session-page');
  await expect(createPage).toBeVisible();
  await expect(createPage.getByTestId('project-location-path')).toHaveText(
    '/Users/nathan/code/nession',
  );
  await expect(createPage.getByTestId('project-location-status-online')).toBeVisible();
  await createPage.locator('#name').fill('project-draft');
  await createPage.getByTestId('app-session-location').click();
  const locationPage = page.getByTestId('app-create-location-page');
  await expect(locationPage).toBeVisible();
  await expect(locationPage.getByTestId('project-location-path')).toHaveText(
    '/Users/nathan/code/nession',
  );
  await expect(locationPage.getByTestId('project-location-status-online')).toBeVisible();
  await locationPage.getByTestId('app-create-location-done').click();
  await expect(createPage.locator('#name')).toHaveValue('project-draft');

  await page.goto('/#/fixture/app?projects=offline');
  await page.getByTestId('app-header-sessions').click();
  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('project-detail-create-session').click();
  const offlinePage = page.getByTestId('app-create-session-page');
  await expect(offlinePage.getByTestId('app-session-location-offline')).toBeVisible();
  await expect(offlinePage.getByTestId('project-location-status-offline')).toBeVisible();
  await offlinePage.locator('#name').fill('offline-draft');
  await expect(offlinePage.getByTestId('create-session-submit')).toBeDisabled();
  await noHorizontalOverflow(page);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App Project create rendered Agent/path/status on distinct lines and preserved the draft; ' +
      'the offline Agent state was explicit and disabled the single Create action',
  });
});
