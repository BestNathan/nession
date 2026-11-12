// #3075 SC-05 browser half: a real Chromium click-through of the published
// public preview at measured 1:1 CSS widths. This is mock interaction evidence,
// deliberately separate from the production fixture Cases and from the runtime
// verifier that pins the published source.
import { expect, test } from '@playwright/test';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

const PROTOTYPE_URL =
  'https://bestnathan.github.io/nession/prototypes/sidebar-navigation-rail-3075/index.html';

test('SC-05: the public preview renders and operates the 246/56 rail at 1:1', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-05');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(PROTOTYPE_URL);
  await expect(page.locator('#product')).toBeVisible();

  const nav = page.locator('#nav-column');
  const main = page.locator('#work-main');
  const fullSidebar = page.locator('#full-sidebar');
  const rail = page.locator('#rail');

  // The review frame renders the product at 1280 CSS px with no scaling.
  const deviceWidth = await page
    .locator('[data-np-device]')
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(deviceWidth).toBe(1280);
  expect((await nav.boundingBox())?.width).toBe(246);

  await fullSidebar.locator('[data-action="collapse"]').click();
  await expect
    .poll(async () => (await nav.boundingBox())?.width ?? -1)
    .toBe(56);
  await expect(rail).toBeVisible();
  expect(await fullSidebar.evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  const railBox = await rail.boundingBox();
  const mainBox = await main.boundingBox();
  expect(railBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  expect(mainBox!.x).toBeGreaterThanOrEqual(railBox!.x + railBox!.width - 0.5);

  await rail.locator('[data-action="expand"]').click();
  await expect
    .poll(async () => (await nav.boundingBox())?.width ?? 0)
    .toBe(246);

  // Search is the existing Session field, focused by the rail shortcut.
  await fullSidebar.locator('[data-action="collapse"]').click();
  await expect
    .poll(async () => (await nav.boundingBox())?.width ?? -1)
    .toBe(56);
  await rail.locator('[data-action="search"]').click();
  await expect(page.locator('#session-search')).toBeFocused();
  await expect
    .poll(async () => (await nav.boundingBox())?.width ?? 0)
    .toBe(246);

  expect(pageErrors, 'the public mock must not throw').toEqual([]);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Chromium loaded ' + PROTOTYPE_URL + ' at a measured 1:1 1280px ' +
      'device; expanded 246px and collapsed 56px were measured, Main began at the rail edge, the ' +
      'hidden Sidebar was inert, and Search focused the existing field; no page errors. This is ' +
      'prototype mock evidence, not production Acceptance',
  });
});
