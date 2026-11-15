'use strict';
// #3523 SC-06: active-layer keyboard avoidance works at portrait/landscape and
// a nonzero safe area; switching Sessions/Terminal/Workspace and opening a
// relevant dialog preserve independent scroll/focus ownership, exactly one App
// header, the same mounted Terminal, and no stranded control outside the
// visible region.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  avoidanceState,
  focusCapsuleComposer,
  installVisualViewportFixture,
  markTerminal,
  resetVisualViewport,
  setKeyboardInset,
  terminalFacts,
  viewportEnvironment,
} = require('../../../shared/keyboard-avoidance-browser.cjs');

const visibleBottomInPage = (page) => page.evaluate(() => {
  const element = document.querySelector('[data-app-viewport-environment]');
  if (!(element instanceof HTMLElement)) return 0;
  return element.getBoundingClientRect().top
    + Number(element.dataset.appVisibleTop ?? 0)
    + Number(element.dataset.appVisibleHeight ?? 0);
});

test('SC-06: orientation, safe area, layers and dialogs keep one focus/scroll owner', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-06');
  await page.setViewportSize({ width: 390, height: 844 });
  await installVisualViewportFixture(page);
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-layer-root').waitFor({ timeout: 30_000 });
  await page.locator('.xterm').waitFor({ timeout: 30_000 });
  await expect.poll(async () => (await terminalFacts(page))?.rows ?? 0, {
    timeout: 20_000,
  }).toBeGreaterThan(0);
  await markTerminal(page);

  // A nonzero safe area is a fixture input, mapped by the App environment.
  await page.evaluate(() => {
    const element = document.querySelector('[data-app-viewport-environment]');
    if (!(element instanceof HTMLElement)) return;
    element.style.setProperty('--nession-test-safe-area-top', '44px');
    element.style.setProperty('--nession-test-safe-area-left', '44px');
    element.style.setProperty('--nession-test-safe-area-bottom', '21px');
  });
  await resetVisualViewport(page);
  await expect.poll(async () => (await viewportEnvironment(page))?.safeAreaBottom, {
    timeout: 10_000,
  }).toBe(21);
  expect((await viewportEnvironment(page))?.safeAreaLeft).toBe(44);

  // Portrait keyboard: the composer is revealed above the visible bottom.
  await setKeyboardInset(page, 300);
  await focusCapsuleComposer(page);
  await expect.poll(async () => (await avoidanceState(page))?.scrollable, {
    timeout: 10_000,
  }).toBe(true);
  const portrait = await avoidanceState(page);
  expect(portrait?.targetBottom ?? Infinity).toBeLessThanOrEqual(
    (await visibleBottomInPage(page)) - 8,
  );
  expect(await page.getByTestId('session-header-line').count()).toBe(1);

  // Orientation is a real layout change; the visual viewport follows it and the
  // focused composer remains revealable in landscape.
  await page.setViewportSize({ width: 844, height: 390 });
  await resetVisualViewport(page);
  await setKeyboardInset(page, 210);
  await expect.poll(async () => (await viewportEnvironment(page))?.layoutWidth, {
    timeout: 15_000,
  }).toBe(844);
  await expect.poll(async () => (await viewportEnvironment(page))?.visibleHeight, {
    timeout: 10_000,
  }).toBe(180);
  await expect.poll(async () => (await avoidanceState(page))?.scrollable, {
    timeout: 10_000,
  }).toBe(true);
  const landscape = await avoidanceState(page);
  expect(landscape?.targetBottom ?? Infinity).toBeLessThanOrEqual(
    (await visibleBottomInPage(page)) - 8,
  );
  expect(landscape?.targetTop ?? 0).toBeGreaterThanOrEqual(0);
  expect(await page.getByTestId('session-header-line').count()).toBe(1);

  // Layer switch: the covered Terminal layer releases its focus and range, and
  // the same xterm instance stays mounted underneath.
  await page.getByTestId('app-header-sessions').first().click();
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'sessions');
  await expect.poll(async () => (await avoidanceState(page))?.scrollable, {
    timeout: 10_000,
  }).toBe(false);
  expect(await page.evaluate(
    () => document.activeElement?.getAttribute('data-testid') === 'capsule-ghost-input',
  )).toBe(false);
  expect(await page.locator('.xterm').count()).toBe(1);
  expect((await terminalFacts(page))?.xtermIdentity).toBe('original');

  // A relevant dialog opens its own focus owner outside the App frame; it must
  // not create an App avoidance scroll for a control it does not own.
  await page.getByTestId('create-session').click();
  await expect(page.getByTestId('app-create-session-page')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('app-session-name').focus();
  await expect.poll(async () => (await viewportEnvironment(page))?.editableFocus, {
    timeout: 10_000,
  }).toBe(false);
  expect((await viewportEnvironment(page))?.keyboard).toBe('closed');
  expect((await avoidanceState(page))?.scrollable).toBe(false);
  await page.getByTestId('app-create-session-page')
    .getByRole('button', { name: /Sessions/ }).click();
  await expect(page.getByTestId('app-create-session-page')).toHaveCount(0);

  // Return to the Terminal and reveal again; the terminal instance is intact.
  await page.getByTestId('session-item-row').first().click();
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');
  await setKeyboardInset(page, 210);
  await focusCapsuleComposer(page);
  await expect.poll(async () => (await avoidanceState(page))?.scrollable, {
    timeout: 10_000,
  }).toBe(true);
  const returned = await avoidanceState(page);
  expect(returned?.targetBottom ?? Infinity).toBeLessThanOrEqual(
    (await visibleBottomInPage(page)) - 8,
  );
  expect((await terminalFacts(page))?.xtermIdentity).toBe('original');
  expect(await page.getByTestId('session-header-line').count()).toBe(1);
  await resetVisualViewport(page);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': the App environment published safeArea top/left 44 and ' +
      'bottom 21 from the deterministic fixture input; portrait 390x844 with a 300px inset ' +
      'revealed the composer above visibleBounds; landscape 844x390 with a 210px inset and ' +
      'visibleHeight 180 did the same with layoutWidth 844; switching to Sessions released the ' +
      'covered composer focus and the range while the marked xterm instance stayed mounted; the ' +
      'create-session dialog focused its own field outside the App frame with keyboard=closed and ' +
      'no App range; returning to the Terminal revealed the composer again with exactly one ' +
      'session-header-line. Chromium app-owned orientation/safe-area/layer proof.',
  });
});
