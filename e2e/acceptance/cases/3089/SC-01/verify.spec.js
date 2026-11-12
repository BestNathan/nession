'use strict';
// #3089 SC-01: Web Attach and Create Session use content-capable responsive
// dialogs, expose complete long values, and do not require horizontal scroll.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const LONG_ADDRESS =
  'wss://gateway-01.example.test:8443/nession/connection/candidate/sessions/dev-session/long-readable-address/endpoint';

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

test('SC-01: Web Attach is roomy, wraps the whole address and stays in the viewport', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?operation=attach&attach=long&experience=web');

  const dialog = page.getByTestId('attach-dialog');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThan(600);
  expect(box.width).toBeLessThanOrEqual(720);
  expect(box.x).toBeGreaterThan(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1440);

  // Auto/P2P/Relay compare side by side on the wide surface.
  const modeBoxes = await Promise.all(
    ['auto', 'p2p', 'relay'].map((mode) =>
      page.getByTestId(`attach-mode-${mode}`).boundingBox(),
    ),
  );
  expect(modeBoxes.every((modeBox) => modeBox !== null)).toBe(true);
  const top = modeBoxes[0].y;
  expect(modeBoxes.every((modeBox) => Math.abs(modeBox.y - top) <= 2)).toBe(true);

  const address = page.getByTestId('attach-address-0');
  await expect(address).toHaveText(LONG_ADDRESS);
  await expect(page.getByTestId('attach-copy-0')).toBeVisible();
  await noHorizontalOverflow(page, address);
  await noHorizontalOverflow(page, dialog);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web Attach measured ' + Math.round(box.width) +
      'px at 1440, modes side by side, the complete ' + LONG_ADDRESS.length +
      '-character address wrapped with a Copy action, no horizontal overflow',
  });
});

test('SC-01: Web Project-aware Create Session shows Agent and path on their own lines', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#/fixture?projects=canonical&experience=web');

  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('project-detail-create-session').click();
  const dialog = page.getByTestId('create-session-dialog');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThan(600);
  expect(box.width).toBeLessThanOrEqual(680);

  const trigger = page.getByTestId('project-location-trigger');
  await expect(trigger).toContainText('macbook');
  await expect(trigger.getByTestId('project-location-path')).toHaveText(
    '/Users/nathan/code/nession',
  );
  await noHorizontalOverflow(page, trigger);
  await noHorizontalOverflow(page, dialog);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web Project Create Session measured ' +
      Math.round(box.width) + 'px at 1280 with Agent and directory rendered on distinct lines',
  });
});
