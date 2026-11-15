'use strict';
// #3523 SC-03: while a keyboard avoidance range exists, a vertical touch drag
// that begins in the Terminal viewport moves **only** the outer page; xterm's
// own history/wheel path does not also receive that delta. Horizontal edge
// navigation outside that gesture still reaches the shell pager, and a tap is
// never converted into a scroll.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  avoidanceState,
  focusCapsuleComposer,
  installVisualViewportFixture,
  resetVisualViewport,
  setKeyboardInset,
  terminalFacts,
  viewportEnvironment,
} = require('../../../shared/keyboard-avoidance-browser.cjs');
const {
  shellAnchor,
  startTouch,
  moveTouch,
  endTouch,
  swipe,
} = require('../../../shared/swipe-2724-cases.cjs');

test('SC-03: vertical drags move only the outer owner; horizontal/taps stay owned', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-03');
  await page.setViewportSize({ width: 390, height: 844 });
  await installVisualViewportFixture(page);
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-layer-root').waitFor({ timeout: 30_000 });
  await page.locator('.xterm').waitFor({ timeout: 30_000 });
  await expect.poll(async () => (await terminalFacts(page))?.rows ?? 0, {
    timeout: 20_000,
  }).toBeGreaterThan(0);

  await setKeyboardInset(page, 300);
  await focusCapsuleComposer(page);
  await expect.poll(async () => (await avoidanceState(page))?.scrollable, {
    timeout: 10_000,
  }).toBe(true);

  const visibleBottom = await page.evaluate(() => {
    const element = document.querySelector('[data-app-viewport-environment]');
    if (!(element instanceof HTMLElement)) return 0;
    return element.getBoundingClientRect().top
      + Number(element.dataset.appVisibleTop ?? 0)
      + Number(element.dataset.appVisibleHeight ?? 0);
  });
  const box = await page.getByTestId('fixture-terminal').boundingBox();
  if (!box) throw new Error('the terminal viewport must be laid out');
  const scrollTopBefore = (await avoidanceState(page))?.scrollTop ?? 0;
  const xtermBefore = (await terminalFacts(page))?.xtermScrollTop;
  const point = {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(Math.max(80, Math.min(box.y + box.height / 2, visibleBottom - 48))),
  };

  // A tap is not a scroll and does not navigate.
  await startTouch(page, point);
  await endTouch(page, point);
  expect((await avoidanceState(page))?.scrollTop).toBe(scrollTopBefore);
  expect(await page.getByTestId('app-layer-root').getAttribute('data-layer')).toBe('terminal');

  // Finger down: the outer page spends the range; xterm does not.
  await startTouch(page, point);
  await moveTouch(page, { x: point.x, y: point.y + 60 });
  await moveTouch(page, { x: point.x, y: point.y + 120 });
  await endTouch(page, { x: point.x, y: point.y + 120 });
  await expect.poll(async () => (await avoidanceState(page))?.scrollTop ?? -1, {
    timeout: 10_000,
  }).toBeLessThan(scrollTopBefore);
  expect((await terminalFacts(page))?.xtermScrollTop, 'no doubled terminal scroll')
    .toBe(xtermBefore);

  // Finger up at the range's end: the next contact belongs to the Terminal for
  // its whole duration; the outer page is not moved.
  await page.evaluate(() => {
    const scrollport = document.querySelector('[data-keyboard-avoidance-scrollport]');
    if (scrollport instanceof HTMLElement) {
      scrollport.scrollTop = scrollport.scrollHeight - scrollport.clientHeight;
    }
  });
  const atEnd = (await avoidanceState(page))?.scrollTop ?? 0;
  const xtermAtEnd = (await terminalFacts(page))?.xtermScrollTop;
  const upStart = { x: point.x, y: Math.round(Math.max(80, visibleBottom - 160)) };
  await startTouch(page, upStart);
  await moveTouch(page, { x: upStart.x, y: upStart.y - 60 });
  await moveTouch(page, { x: upStart.x, y: upStart.y - 120 });
  await endTouch(page, { x: upStart.x, y: upStart.y - 120 });
  expect((await avoidanceState(page))?.scrollTop, 'exhausted range is not claimed')
    .toBe(atEnd);
  expect((await terminalFacts(page))?.xtermScrollTop, 'the terminal keeps that gesture')
    .toBe(xtermAtEnd);

  // Horizontal edge navigation still reaches the shell pager.
  const anchor = await shellAnchor(page);
  await swipe(page, {
    from: { x: anchor.leftX, y: anchor.y },
    to: { x: anchor.leftX + 160, y: anchor.y },
  });
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'sessions');
  const composerFocused = await page.evaluate(
    () => document.activeElement?.getAttribute('data-testid') === 'capsule-ghost-input',
  );
  expect(composerFocused, 'leaving the layer releases the covered focus').toBe(false);
  expect((await avoidanceState(page))?.scrollable, 'the inactive layer has no range').toBe(false);
  expect(await page.locator('.xterm').count(), 'the Terminal stays mounted').toBe(1);
  await resetVisualViewport(page);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': with a 300px keyboard-like inset and Capsule focus, ' +
      'a tap left scrollTop unchanged; a 120px downward Terminal drag moved only the outer ' +
      'scrollport (scrollTop ' + scrollTopBefore + ' -> below) while the xterm viewport scrollTop ' +
      'stayed ' + xtermBefore + '; an upward drag at the range end moved neither owner; a ' +
      'horizontal edge swipe still committed the Sessions layer without doubled scroll; the ' +
      'layer change blurred the covered composer, released the range and kept one mounted xterm. ' +
      'Chromium app-owned gesture proof, not native Safari/OS gesture proof.',
  });
});
