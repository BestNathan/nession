'use strict';
// #3523 SC-02: with a keyboard-like visible bound and focus on the Capsule
// composer, the control is revealable above the visible bottom by **real**
// bounded outer scrolling, while the Terminal well dimensions, xterm grid rows
// and the mounted Terminal instance stay unchanged across keyboard
// open/adjust/close.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  avoidanceState,
  blurActive,
  focusCapsuleComposer,
  installVisualViewportFixture,
  markTerminal,
  resetVisualViewport,
  setKeyboardInset,
  terminalFacts,
  viewportEnvironment,
} = require('../../../shared/keyboard-avoidance-browser.cjs');

test('SC-02: Capsule focus uses a real bounded outer scroll without Terminal resize', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 390, height: 844 });
  await installVisualViewportFixture(page);
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-layer-root').waitFor({ timeout: 30_000 });
  await page.locator('.xterm').waitFor({ timeout: 30_000 });
  await expect.poll(async () => (await terminalFacts(page))?.rows ?? 0, {
    timeout: 20_000,
  }).toBeGreaterThan(0);
  await markTerminal(page);
  const before = await terminalFacts(page);
  const headerBefore = await page.getByTestId('session-header-line').boundingBox();

  await setKeyboardInset(page, 300);
  await expect.poll(async () => (await viewportEnvironment(page))?.keyboard, {
    timeout: 10_000,
  }).toBe('closed');
  expect((await avoidanceState(page))?.scrollable, 'no focus, no avoidance range').toBe(false);

  await focusCapsuleComposer(page);
  await expect.poll(async () => (await viewportEnvironment(page))?.keyboard, {
    timeout: 10_000,
  }).toBe('open');
  await expect.poll(async () => (await avoidanceState(page))?.scrollable, {
    timeout: 10_000,
  }).toBe(true);
  await expect.poll(async () => (await avoidanceState(page))?.scrollTop ?? 0, {
    timeout: 10_000,
  }).toBeGreaterThan(0);

  const revealed = await avoidanceState(page);
  const visibleBottom = await page.evaluate(() => {
    const element = document.querySelector('[data-app-viewport-environment]');
    if (!(element instanceof HTMLElement)) return 0;
    return element.getBoundingClientRect().top
      + Number(element.dataset.appVisibleTop ?? 0)
      + Number(element.dataset.appVisibleHeight ?? 0);
  });
  expect(revealed?.activeTestId).toBe('capsule-ghost-input');
  expect(revealed?.overflowY).toBe('auto');
  expect(revealed?.extent ?? 0).toBeGreaterThan(0);
  expect(revealed?.scrollHeight ?? 0, 'a real scroll range, not a transform')
    .toBeGreaterThan(revealed?.clientHeight ?? 0);
  expect(revealed?.targetBottom ?? Infinity).toBeLessThanOrEqual(visibleBottom - 8);
  expect(revealed?.targetTop ?? 0).toBeGreaterThanOrEqual(0);

  const during = await terminalFacts(page);
  expect(during?.rows).toBe(before?.rows);
  expect(during?.resizes).toBe(before?.resizes);
  expect(during?.hostHeight).toBe(before?.hostHeight);
  expect(during?.hostWidth).toBe(before?.hostWidth);
  expect(during?.wellHeight).toBe(before?.wellHeight);
  expect(during?.xtermCount).toBe(1);
  expect(during?.xtermIdentity).toBe('original');
  expect(await page.getByTestId('session-header-line').isVisible()).toBe(true);
  expect(await page.getByTestId('session-header-line').boundingBox()).toEqual(headerBefore);

  // A keyboard-height adjustment reconciles the range without re-fitting.
  await setKeyboardInset(page, 360);
  await expect.poll(async () => (await viewportEnvironment(page))?.visibleHeight, {
    timeout: 10_000,
  }).toBe(484);
  const adjusted = await avoidanceState(page);
  const adjustedVisibleBottom = await page.evaluate(() => {
    const element = document.querySelector('[data-app-viewport-environment]');
    if (!(element instanceof HTMLElement)) return 0;
    return element.getBoundingClientRect().top
      + Number(element.dataset.appVisibleTop ?? 0)
      + Number(element.dataset.appVisibleHeight ?? 0);
  });
  expect(adjusted?.targetBottom ?? Infinity).toBeLessThanOrEqual(adjustedVisibleBottom - 8);
  expect((await terminalFacts(page))?.rows).toBe(before?.rows);

  await blurActive(page);
  await expect.poll(async () => (await avoidanceState(page))?.scrollable, {
    timeout: 10_000,
  }).toBe(false);
  await expect.poll(async () => (await avoidanceState(page))?.scrollTop, {
    timeout: 10_000,
  }).toBe(0);
  const closed = await terminalFacts(page);
  expect(closed?.rows).toBe(before?.rows);
  expect(closed?.resizes).toBe(before?.resizes);
  await resetVisualViewport(page);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': at 390x844 with a 300px keyboard-like visible inset, ' +
      'Capsule focus produced a real scroll range (scrollHeight > clientHeight, scrollTop > 0, ' +
      'extent > 0) that placed the composer just above visibleBounds; the terminal well box, ' +
      'xterm rows (' + before?.rows + '), xterm resize count (' + before?.resizes + ') and xterm ' +
      'instance were unchanged; the one App header stayed visible and unmoved; a 60px keyboard ' +
      'adjustment reconciled the range with the same rows; blur removed the range and clamped ' +
      'scrollTop to 0. Chromium app-owned behavior, not native IME proof.',
  });
});
