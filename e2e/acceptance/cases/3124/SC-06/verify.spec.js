'use strict';
// #3124 SC-06: the existing Workspace Capsule, Terminal continuity and the
// App's one-Back-per-depth stay intact. The composer and confirmation are
// full-width capability content, never a shrunk modal; the KV rows and the
// inside projection fit the pane; the scroller clears the Capsule.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test.setTimeout(180_000);

test('SC-06: App 390 pushes one full-width confirmation with the shell Back', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-06');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();

  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toContainText('Sandbox');
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to terminal');

  await page.getByTestId('sandbox-preflight').click();
  await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
  await page.getByTestId('sandbox-enter').click();

  await expect(page.getByTestId('sandbox-confirm')).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toContainText('Enter Sandbox');
  await expect(page.getByTestId('app-page-back')).toHaveCount(1);
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to Sandbox');

  // Back on the confirmation cancels the action and preserves the draft.
  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('sandbox-composer')).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toContainText('Sandbox');
  await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();

  // Confirming moves to the inside projection at the same one-Back depth.
  await page.getByTestId('sandbox-enter').click();
  await page.getByTestId('sandbox-confirm-enter').click();
  await expect(page.getByTestId('sandbox-inside')).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toContainText('Sandbox');
  await expect(page.getByTestId('app-page-back')).toHaveCount(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 390 rendered the Sandbox composer at the capability root, ' +
      'pushed exactly one Enter-Sandbox page with the shell Back, cancelled without losing the ' +
      'validated draft, and reached the inside projection with one Back',
  });
});

test('SC-06: App 390 KV rows and scroller fit the pane and clear the Capsule', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-06');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();

  await page.getByTestId('sandbox-resource-add').click();
  await expect(page.getByTestId('sandbox-resource-row-0')).toBeVisible();

  const keyBox = await page.getByTestId('sandbox-resource-key-0').boundingBox();
  const valueBox = await page.getByTestId('sandbox-resource-value-0').boundingBox();
  expect(keyBox).not.toBeNull();
  expect(valueBox).not.toBeNull();
  expect(keyBox.x).toBeGreaterThanOrEqual(0);
  expect(keyBox.x + keyBox.width).toBeLessThanOrEqual(390);
  expect(valueBox.x + valueBox.width).toBeLessThanOrEqual(390);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  // The App tool bar overlays the pane; the scroll container must publish the
  // measured clearance rather than ending under it.
  await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();
  const paddingBottom = await page
    .getByTestId('sandbox-app-scroll')
    .evaluate((element) => getComputedStyle(element).paddingBottom);
  expect(parseFloat(paddingBottom)).toBeGreaterThan(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 390 contained both Key and Value inputs inside the viewport, ' +
      'had no horizontal page overflow, and the Sandbox scroller carried positive Capsule clearance',
  });
});

test('SC-06: App 375 inside projection and Web 1024 composer stay inside the pane', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-06');

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#/fixture/app?sandbox=inside');
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();
  await expect(page.getByTestId('sandbox-inside')).toBeVisible();
  await expect(page.getByTestId('sandbox-scope-note')).toBeVisible();
  let overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/#/fixture/workspace?capability=sandbox');
  await page.getByTestId('sandbox-resource-add').click();
  await expect(page.getByTestId('sandbox-resource-row-0')).toBeVisible();
  overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  const keyBox = await page.getByTestId('sandbox-resource-key-0').boundingBox();
  expect(keyBox).not.toBeNull();
  expect(keyBox.x + keyBox.width).toBeLessThanOrEqual(1024);
  await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-files')).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 375 showed the read-only inside projection without overflow; ' +
      'Web 1024 contained the KV row and kept the existing capability dock',
  });
});
