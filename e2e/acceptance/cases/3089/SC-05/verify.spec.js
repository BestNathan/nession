'use strict';
// #3089 SC-05: App Project create/settings are full-height, stacked and
// touch-sized; the forced experience route decides Web vs App; landscape keeps
// one header, the CTA in the safe area and no horizontal overflow.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

async function noHorizontalOverflow(page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test('SC-05: App Project create and settings stack touch-sized locations', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-05');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#/fixture/app?projects=canonical');

  await page.getByTestId('app-header-sessions').click();
  await page.getByTestId('project-create').click();
  const createPage = page.getByTestId('app-project-create-page');
  await expect(createPage).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toHaveCount(1);
  await createPage.getByTestId('project-location-add').click();
  const editor = page.getByTestId('project-location-editor');
  await expect(editor).toBeVisible();
  const direction = await editor.evaluate((element) => getComputedStyle(element).flexDirection);
  expect(direction).toBe('column');
  for (const testId of ['project-location-add', 'project-location-remove-0']) {
    const box = await page.getByTestId(testId).boundingBox();
    expect(box).not.toBeNull();
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await noHorizontalOverflow(page);

  await page.getByTestId('app-page-back').click();
  await expect(createPage).not.toBeVisible();
  await page.locator('[data-testid^="project-actions-"]').first().click();
  await page.locator('[data-testid^="project-actions-settings-"]').first().click();
  const settingsPage = page.getByTestId('app-project-settings-page');
  await expect(settingsPage).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toHaveCount(1);
  await expect(settingsPage.getByTestId('project-location-editor')).toBeVisible();
  await noHorizontalOverflow(page);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 375 Project create and settings were one-header depths with stacked locations, ' +
      '44px Add/Remove controls and no horizontal overflow; Back was the only leave',
  });
});

test('SC-05: forced Web stays Web, and App landscape keeps one header and anchored CTA', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-05');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture?operation=create-session&projects=canonical&experience=web');
  await expect(page.getByTestId('create-session-dialog')).toBeVisible();
  await expect(page.getByTestId('app-create-session-page')).toHaveCount(0);

  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/#/fixture/app?operation=create-session');
  const createPage = page.getByTestId('app-create-session-page');
  await expect(createPage).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toHaveCount(1);
  const pageBox = await createPage.boundingBox();
  expect(pageBox).not.toBeNull();
  expect(pageBox.height).toBeCloseTo(390, 0);
  const footerBox = await page.getByTestId('app-create-session-page-footer').boundingBox();
  expect(footerBox).not.toBeNull();
  expect(footerBox.y + footerBox.height).toBeCloseTo(390, 0);
  await noHorizontalOverflow(page);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a 390 forced Web route rendered the Web create dialog with no App page; ' +
      'App 844x390 rendered one full-height page header, snapped footer and no horizontal overflow',
  });
});
