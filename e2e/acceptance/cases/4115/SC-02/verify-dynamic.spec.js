'use strict';
// #4115 SC-02 (dynamic geometry): the measured extent follows the App surface,
// the Host-owned actions row and the viewport instead of going stale.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const keyboard = require('../../../shared/keyboard-avoidance-browser.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

test('SC-02 recomputes the endpoint as content, host actions and viewport change', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');

  await page.setViewportSize({ width: 390, height: 844 });
  await helper.openFilesLong(page);

  const atRest = await helper.scrollToEndAndMeasure(page);
  helper.expectEndpoint(atRest, 'Files rest');
  helper.expectHostInset(atRest, 'Files rest');
  expect(Number.parseFloat(atRest.host.scrollInset)).toBeGreaterThan(0);

  // The Host-owned actions row appears: the scrollport now ends above it, so
  // the honest scroll inset is zero rather than a stale reserved band.
  await helper.longPress(page, '[data-testid="file-row-bulk/filler-00000.txt"]');
  await page.getByTestId('files-app-selection-bottom').waitFor({ timeout: 10_000 });
  const withActions = await helper.scrollToEndAndMeasure(page);
  helper.expectEndpoint(withActions, 'Files with actions');
  helper.expectHostInset(withActions, 'Files with actions');
  expect(Number.parseFloat(withActions.host.scrollInset), 'actions row removes the reserved tail').toBe(0);
  expect(Number.parseFloat(withActions.host.actionsInset), 'actions band still clears the Capsule').toBeGreaterThan(0);

  // Clearing the selection returns the scrollport to the full band.
  await page.getByTestId('files-app-selection-top').getByRole('button', { name: 'Exit selection' }).click();
  await page.getByTestId('files-app-selection-bottom').waitFor({ state: 'detached', timeout: 10_000 });
  const cleared = await helper.scrollToEndAndMeasure(page);
  helper.expectEndpoint(cleared, 'Files after clearing');
  helper.expectHostInset(cleared, 'Files after clearing');
  expect(Number.parseFloat(cleared.host.scrollInset)).toBeGreaterThan(0);

  // Changed viewport geometry: the same relation is re-measured at each width.
  for (const viewport of helper.appViewports()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(150);
    const state = await helper.scrollToEndAndMeasure(page);
    helper.expectEndpoint(state, `Files resized ${viewport.id}`);
    helper.expectHostInset(state, `Files resized ${viewport.id}`);
  }

  // Changed content and capability chrome: switching away and back remounts
  // the view and the capsule row, and the relation still holds.
  await page.getByTestId('workspace-tool-sandbox').click();
  await page.getByTestId('workspace-tool-files').click();
  await page.getByTestId('file-row-bulk').click();
  await page.getByTestId('files-app-list').waitFor({ timeout: 30_000 });
  const remounted = await helper.scrollToEndAndMeasure(page);
  helper.expectEndpoint(remounted, 'Files remounted');
  helper.expectHostInset(remounted, 'Files remounted');

  // A deterministic safe-area input still counts once: the App environment
  // publishes it, and the host still derives the extent from the bar it drew.
  await page.evaluate(() => {
    const element = document.querySelector('[data-app-viewport-environment]');
    if (element instanceof HTMLElement) {
      element.style.setProperty('--nession-test-safe-area-bottom', '21px');
    }
    // The environment re-reads on a viewport event, which is what a device
    // rotation/safe-area change produces.
    window.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => (await keyboard.viewportEnvironment(page))?.safeAreaBottom).toBe(21);
  const safeArea = await helper.scrollToEndAndMeasure(page);
  helper.expectEndpoint(safeArea, 'Files with safe area');
  helper.expectHostInset(safeArea, 'Files with safe area');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': on a 390-wide long Files list, the host inset was '
      + 'surface-derived at rest; entering Files selection mounted the Host '
      + 'actions row, reduced the scroll inset to 0 and kept the actions band '
      + 'equal to the whole Capsule/safe-area band; clearing it restored the '
      + 'band; 375/390/430 resizes, a capability remount and a 21px deterministic '
      + 'safe-area input all kept the final content/control above the Capsule '
      + 'with no stale padding or document scroll.',
  });
});
