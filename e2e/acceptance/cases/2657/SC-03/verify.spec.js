'use strict';
// #2657 SC-03: from Armed onward the pad exclusively owns the tracked finger.
// Moves/ends/cancels never reach the terminal scroll owner, the scrollback
// offset is pinned, and release/cancel/observer loss tears everything down.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openDirectionPadFixture, terminalView, fillScrollback,
  touchStart, touchMove, touchEnd, touchCancel,
  padState, sentFrames, clearSent, scrollMode, setObserver, annotate,
} = require('../../../shared/terminal-direction-pad-cases.cjs');

async function sentCount(page) {
  return (await sentFrames(page)).length;
}

test('SC-03: exclusive ownership, cancellation and lease loss', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-03');

  await openDirectionPadFixture(page);
  await fillScrollback(page, 120);
  const view = await terminalView(page);
  const start = { x: view.centerX, y: view.centerY };
  const viewportBefore = view.viewportY;
  expect(await scrollMode(page)).toBe('following');

  await clearSent(page);
  await touchStart(page, start);
  await page.waitForTimeout(450);
  await expect.poll(async () => (await padState(page)).present, { timeout: 10_000 })
    .toBe(true);

  // An armed vertical drag would scroll if it leaked to the scroll owner.
  await touchMove(page, { x: start.x, y: start.y - 60 });
  await expect.poll(async () => (await padState(page)).direction, { timeout: 10_000 })
    .toBe('up');
  const afterFirst = await terminalView(page);
  expect(afterFirst.viewportY, 'the armed pad owns the vertical drag').toBe(viewportBefore);
  expect(await scrollMode(page)).toBe('following');

  // Repeated speed changes, reversal, centre return and re-entry keep working
  // after every rendered arrow (the initiating target never detaches).
  for (const point of [
    { x: start.x + 130, y: start.y },
    { x: start.x + 40, y: start.y },
    { x: start.x, y: start.y + 60 },
    { x: start.x, y: start.y },
    { x: start.x - 60, y: start.y },
  ]) {
    await touchMove(page, point);
    const state = await padState(page);
    expect(state.present).toBe(true);
    expect(state.targetConnected, 'the initiating touch target stays connected').toBe(true);
  }
  const afterSequence = await terminalView(page);
  expect(afterSequence.viewportY).toBe(viewportBefore);
  expect(await sentCount(page)).toBeGreaterThanOrEqual(4);

  // Release ends ownership, the guide and the clock; scrolling is free again.
  await touchEnd(page, { x: start.x - 60, y: start.y });
  await expect.poll(async () => (await padState(page)).present, { timeout: 10_000 })
    .toBe(false);
  const afterRelease = await sentCount(page);
  await page.waitForTimeout(1_100);
  expect(await sentCount(page)).toBe(afterRelease);

  // touchend after a real gesture leaves the viewport where it was; a fresh
  // native swipe scrolls again.
  const swipeStart = await terminalView(page);
  await touchStart(page, { x: swipeStart.centerX, y: swipeStart.centerY });
  await touchMove(page, { x: swipeStart.centerX, y: swipeStart.centerY + 64 });
  await touchEnd(page, { x: swipeStart.centerX, y: swipeStart.centerY + 64 });
  await expect.poll(async () => (await terminalView(page)).viewportY, { timeout: 10_000 })
    .toBeLessThan(swipeStart.viewportY);

  // touchcancel tears down without further keys.
  const cancelView = await terminalView(page);
  await clearSent(page);
  await touchStart(page, { x: cancelView.centerX, y: cancelView.centerY });
  await page.waitForTimeout(450);
  await touchMove(page, { x: cancelView.centerX + 50, y: cancelView.centerY });
  await expect.poll(() => sentCount(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  await touchCancel(page, { x: cancelView.centerX + 50, y: cancelView.centerY });
  await expect.poll(async () => (await padState(page)).present, { timeout: 10_000 })
    .toBe(false);
  const afterCancel = await sentCount(page);
  await page.waitForTimeout(1_100);
  expect(await sentCount(page)).toBe(afterCancel);

  // Losing the input lease (observer) stops an armed pad.
  const observerView = await terminalView(page);
  await clearSent(page);
  await touchStart(page, { x: observerView.centerX, y: observerView.centerY });
  await page.waitForTimeout(450);
  expect((await padState(page)).present).toBe(true);
  await setObserver(page, true);
  await expect.poll(async () => (await padState(page)).present, { timeout: 10_000 })
    .toBe(false);
  const afterObserver = await sentCount(page);
  await page.waitForTimeout(1_100);
  expect(await sentCount(page)).toBe(afterObserver);
  await touchEnd(page, { x: observerView.centerX, y: observerView.centerY });
  await setObserver(page, false);

  annotate(
    testInfo,
    sha,
    'an armed vertical drag moved no scrollback (viewportY stayed ' + viewportBefore
    + ', mode following); speed changes, reversal, centre return and re-entry kept the guide '
    + 'and the initiating target connected; release, touchcancel and observer/lease loss each '
    + 'stopped the clock with no further PTY bytes',
  );
});
