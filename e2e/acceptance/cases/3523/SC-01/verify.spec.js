'use strict';
// #3523 SC-01: the App experience publishes **consistent, observable**
// layout-vs-visible geometry across controlled visualViewport resize/scroll,
// window resize and nonzero safe area; a toolbar-like or missing API change
// never invents a keyboard avoidance state or changes terminal layout.
//
// This is Chromium app-owned geometry proof with a deterministic visual
// viewport fixture, not native iOS/Android IME behavior.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  avoidanceState,
  focusCapsuleComposer,
  installVisualViewportFixture,
  removeVisualViewport,
  setKeyboardInset,
  setVisualViewport,
  viewportEnvironment,
} = require('../../../shared/keyboard-avoidance-browser.cjs');

test('SC-01: layout and visible bounds stay separate without a false keyboard', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 390, height: 844 });
  await installVisualViewportFixture(page);
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-layer-root').waitFor({ timeout: 30_000 });

  await expect.poll(async () => (await viewportEnvironment(page))?.layoutHeight, {
    timeout: 15_000,
  }).toBe(844);
  const resting = await viewportEnvironment(page);
  expect(resting?.layoutWidth).toBe(390);
  expect(resting?.visibleWidth).toBe(390);
  expect(resting?.visibleHeight).toBe(844);
  expect(resting?.occludedBottom).toBe(0);
  expect(resting?.keyboard).toBe('closed');
  expect(resting?.editableFocus).toBe(false);

  // Reduced visibility without editable focus (browser toolbar/pan): the
  // visible rectangle moves, no keyboard session and no scroll range exists.
  await setKeyboardInset(page, 300);
  await expect.poll(async () => (await viewportEnvironment(page))?.visibleHeight, {
    timeout: 10_000,
  }).toBe(544);
  const toolbar = await viewportEnvironment(page);
  expect(toolbar?.occludedBottom).toBe(300);
  expect(toolbar?.keyboard).toBe('closed');
  expect((await avoidanceState(page))?.scrollable).toBe(false);

  // Editable focus + reduced visibility is the actionable session.
  await focusCapsuleComposer(page);
  await expect.poll(async () => (await viewportEnvironment(page))?.keyboard, {
    timeout: 10_000,
  }).toBe('open');
  await expect.poll(async () => (await avoidanceState(page))?.scrollable, {
    timeout: 10_000,
  }).toBe(true);

  // Pan/zoom: the same shell-local coordinate space, clipped to layout bounds.
  // A 2× scale reports 195×272 visual pixels, which are 390×544 layout pixels.
  await setVisualViewport(page, {
    offsetLeft: 20,
    offsetTop: 40,
    width: 195,
    height: 272,
    scale: 2,
  });
  await expect.poll(async () => (await viewportEnvironment(page))?.visibleWidth, {
    timeout: 10_000,
  }).toBe(370);
  const zoomed = await viewportEnvironment(page);
  expect(zoomed?.visibleLeft).toBe(20);
  expect(zoomed?.visibleTop).toBe(40);
  expect(zoomed?.visibleHeight).toBe(544);
  expect(zoomed?.occludedLeft).toBe(20);
  expect(zoomed?.occludedTop).toBe(40);
  expect(zoomed?.occludedRight).toBe(0);
  expect(zoomed?.occludedBottom).toBe(260);

  // Missing API: fall back to the layout rectangle; no keyboard, no range.
  await removeVisualViewport(page);
  await expect.poll(async () => (await viewportEnvironment(page))?.visibleHeight, {
    timeout: 10_000,
  }).toBe(844);
  const missing = await viewportEnvironment(page);
  expect(missing?.visibleWidth).toBe(390);
  expect(missing?.keyboard).toBe('closed');
  expect(missing?.occludedBottom).toBe(0);
  expect(await page.getByTestId('app-layer-root').getAttribute('data-layer')).toBe('terminal');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': at 390x844 the App environment published layout ' +
      '390x844 and the same visible rectangle at rest; an unfocused 300px visual-viewport ' +
      'shrink published visibleHeight=544, occludedBottom=300 with keyboard=closed and no ' +
      'scrollport range; Capsule focus made keyboard=open and a real range appear; a 2x ' +
      'pan/zoom snapshot mapped to shell-local 20,40 / 370x544 with the correct edge ' +
      'occlusions; removing window.visualViewport fell back to the layout rectangle with no ' +
      'keyboard state. Chromium app-owned geometry, not native IME proof.',
  });
});
