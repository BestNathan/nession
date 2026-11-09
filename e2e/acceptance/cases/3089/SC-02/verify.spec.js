'use strict';
// #3089 SC-02: Web Project create/settings keep Existing Locations readable
// and editable, reflow within the dialog, and never require horizontal scroll.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const LONG_PATH =
  '/srv/workspaces/nession/infrastructure/experiments/agent-workspaces/very-long-nested-source-root/feature-branches/session-runtime';

async function noHorizontalOverflow(page, locator) {
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(pageOverflow).toBeLessThanOrEqual(1);
  const elementOverflow = await locator.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(elementOverflow).toBeLessThanOrEqual(1);
}

test('SC-02: Project create is a roomy dialog whose location row reflows', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#/fixture?projects=canonical&experience=web');

  await page.getByTestId('project-create').click();
  const dialog = page.getByTestId('create-project-dialog');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThan(680);
  expect(box.width).toBeLessThanOrEqual(760);

  await page.getByTestId('project-location-add').click();
  const path = page.locator('#project-create-location-path-0');
  await path.fill(LONG_PATH);
  await expect(path).toHaveValue(LONG_PATH);
  await expect(page.getByTestId('project-location-editor')).toBeVisible();
  const rows = await page.getByTestId('project-location-editor').evaluate(
    (element) => getComputedStyle(element).flexDirection,
  );
  expect(rows).toBe('row');
  await noHorizontalOverflow(page, path);
  await noHorizontalOverflow(page, dialog);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web Project create measured ' + Math.round(box.width) +
      'px at 1280, a ' + LONG_PATH.length + '-character directory remained editable and fully within the dialog',
  });
});

test('SC-02: forced narrow Web stacks the location editor without horizontal scroll', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#/fixture?projects=canonical&experience=web');

  await page.getByTestId('project-create').click();
  const dialog = page.getByTestId('create-project-dialog');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeLessThanOrEqual(343);

  await page.getByTestId('project-location-add').click();
  await page.locator('#project-create-location-path-0').fill(LONG_PATH);
  const direction = await page.getByTestId('project-location-editor').evaluate(
    (element) => getComputedStyle(element).flexDirection,
  );
  expect(direction).toBe('column');
  await noHorizontalOverflow(page, page.getByTestId('project-location-editor'));
  await noHorizontalOverflow(page, dialog);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': forced narrow Web at 375 stacked the Agent/Directory editor at ' +
      Math.round(box.width) + 'px with no horizontal overflow',
  });
});
