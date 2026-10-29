'use strict';
// #2592 SC-05: orientation/width/font-load keep the Agent's fixed columns and
// change the font; height-only changes rows without a font refit.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, openAppFixture, measureApp, waitForStableFit,
} = require('../../../shared/terminal-density-cases.cjs');

test('SC-05: width/orientation refit, height-only rows, loaded face', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-05');
  await openAppFixture(page, 390, 844);
  const portrait = await measureApp(page);
  expect(portrait.cols).toBe(96);
  expect(await page.evaluate(() => document.fonts.status)).toBe('loaded');

  // Landscape orientation: the same Session columns, a width-driven font.
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(async () => (await measureApp(page)).rows, { timeout: 15_000 })
    .toBeLessThan(portrait.rows);
  await waitForStableFit(page);
  const landscape = await measureApp(page);
  expect(landscape.cols, 'orientation must not change columns').toBe(96);
  expect(landscape.fontSize, 'the wider orientation may choose a larger fit')
    .toBeGreaterThanOrEqual(portrait.fontSize);
  expect(landscape.rows, 'the shorter orientation shows fewer rows')
    .toBeLessThan(portrait.rows);
  expect(landscape.fit).toBe('true');

  // Back to portrait: the font returns to the same fitted size.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => Math.abs((await measureApp(page)).fontSize - portrait.fontSize),
    { timeout: 15_000 }).toBeLessThan(0.05);
  await waitForStableFit(page);
  const restored = await measureApp(page);
  expect(restored.cols).toBe(96);
  expect(restored.fontSize).toBeCloseTo(portrait.fontSize, 6);

  // Width-only change: font shrinks, columns stay.
  await page.setViewportSize({ width: 375, height: 844 });
  await expect.poll(async () => (await measureApp(page)).fontSize, { timeout: 15_000 })
    .toBeLessThanOrEqual(portrait.fontSize);
  await waitForStableFit(page);
  const narrow = await measureApp(page);
  expect(narrow.cols).toBe(96);
  expect(narrow.fontSize).toBeLessThanOrEqual(portrait.fontSize);
  expect(narrow.fit).toBe('true');

  // Height-only change: no font refit, rows follow.
  await page.setViewportSize({ width: 375, height: 700 });
  await expect.poll(async () => (await measureApp(page)).rows, { timeout: 15_000 })
    .toBeLessThan(narrow.rows);
  await waitForStableFit(page);
  const short = await measureApp(page);
  expect(short.fontSize, 'height-only must not refit the font').toBeCloseTo(
    narrow.fontSize, 6,
  );
  expect(short.rows).toBeLessThan(narrow.rows);
  expect(short.cellHeight).toBeCloseTo(narrow.cellHeight, 6);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': portrait 390 font ' + portrait.fontSize +
      ' rows ' + portrait.rows + '; landscape 844 font ' + landscape.fontSize +
      ' rows ' + landscape.rows + '; restored font ' + restored.fontSize +
      '; width 375 font ' + narrow.fontSize + '; height 700 kept font ' +
      short.fontSize + ' rows ' + short.rows + '; cols 96 throughout',
  });
});
