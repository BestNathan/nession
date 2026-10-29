'use strict';
// #2592 SC-03: the App fit has no Nession minimum font size, derives the size
// from actual width + fixed columns (including below 6px), refits on width,
// keeps rows-only changes font-stable, and never scrolls horizontally.
const { test, expect } = require('@playwright/test');
const {
  APP_VIEWPORTS, BELOW_SIX_VIEWPORTS, verifiedRuntime, openAppFixture, measureApp,
  waitForStableFit,
} = require('../../../shared/terminal-density-cases.cjs');

test('SC-03: unbounded-below measured fit at fixed columns, no horizontal scroll', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-03');
  const fonts = [];
  const evidence = [];

  for (const [width, height] of APP_VIEWPORTS) {
    await openAppFixture(page, width, height);
    const m = await measureApp(page);
    const label = width + 'x' + height + ' ' + JSON.stringify(m);
    expect(m.cols, label).toBe(96);
    expect(m.fit, label).toBe('true');
    expect(m.fontSize, label).toBeGreaterThan(0);
    expect(m.gridWidth, label).toBeLessThanOrEqual(m.contentBoxWidth + 0.5);
    expect(m.scrollWidth, 'no horizontal scroll: ' + label).toBe(m.clientWidth);
    fonts.push({ width, fontSize: m.fontSize });
    evidence.push(width + 'px font ' + m.fontSize + ' cell ' + m.cellWidth +
      ' grid ' + m.gridWidth.toFixed(2) + '/' + m.contentBoxWidth.toFixed(2));
  }

  // Width defines the fit: a wider App viewport never chooses a smaller font,
  // and never a different column count. Device-pixel quantization may keep two
  // adjacent widths on one step, so only the endpoints are strictly ordered.
  for (let index = 1; index < fonts.length; index += 1) {
    expect(fonts[index].fontSize, 'wider width must not shrink the font: ' +
      JSON.stringify(fonts)).toBeGreaterThanOrEqual(fonts[index - 1].fontSize);
  }
  expect(fonts[fonts.length - 1].fontSize, 'the wide endpoint is larger: ' + JSON.stringify(fonts))
    .toBeGreaterThan(fonts[0].fontSize);

  // No application floor: at widths whose fixed 96 columns need less than 6px,
  // the measured fit still succeeds.
  for (const [width, height] of BELOW_SIX_VIEWPORTS) {
    await openAppFixture(page, width, height);
    const m = await measureApp(page);
    const label = 'below-six ' + width + 'x' + height + ' ' + JSON.stringify(m);
    expect(m.cols, label).toBe(96);
    expect(m.fontSize, 'no 6px clamp: ' + label).toBeGreaterThan(0);
    expect(m.fontSize, 'chosen below the old 6px floor: ' + label).toBeLessThan(6);
    expect(m.fit, label).toBe('true');
    expect(m.gridWidth, label).toBeLessThanOrEqual(m.contentBoxWidth + 0.5);
    expect(m.scrollWidth, label).toBe(m.clientWidth);
    evidence.push(width + 'px font ' + m.fontSize + ' (<6) fit ' + m.fit);
  }

  // A width change refits; a height-only change keeps the chosen font and only
  // changes rows.
  await openAppFixture(page, 430, 932);
  const wide = await measureApp(page);
  await page.setViewportSize({ width: 375, height: 932 });
  await expect.poll(async () => (await measureApp(page)).fontSize, { timeout: 15_000 })
    .toBeLessThan(wide.fontSize);
  await waitForStableFit(page);
  const narrow = await measureApp(page);
  expect(narrow.cols).toBe(96);
  expect(narrow.fontSize).toBeLessThan(wide.fontSize);

  await page.setViewportSize({ width: 375, height: 700 });
  await expect.poll(async () => (await measureApp(page)).rows, { timeout: 15_000 })
    .toBeLessThan(narrow.rows);
  await waitForStableFit(page);
  const short = await measureApp(page);
  expect(short.fontSize, 'height-only change must not refit the font').toBeCloseTo(
    narrow.fontSize, 6,
  );
  expect(short.rows, 'rows follow height').toBeLessThan(narrow.rows);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + evidence.join('; ') +
      '; width change 430->375 refit font ' + wide.fontSize + '->' + narrow.fontSize +
      ' with cols 96; height-only 932->700 kept font ' + short.fontSize +
      ' and changed rows ' + narrow.rows + '->' + short.rows,
  });
});
