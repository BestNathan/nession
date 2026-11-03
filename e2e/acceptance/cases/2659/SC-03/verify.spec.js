'use strict';
// #2659 SC-03: horizontal drags (selection/pager), the locked horizontal axis,
// a second finger and a tap are never claimed by the terminal scroll handler.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { emit, sentFrames } = require('../../../shared/terminal-clipboard-cases.cjs');
const {
  dispatchTouch, fillScrollback, openScrollFixture, terminalView,
} = require('../../../shared/terminal-touch-scroll-cases.cjs');

test('SC-03: non-vertical gestures keep their own owners', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-03');
  await openScrollFixture(page);
  await fillScrollback(page, 80);

  const view = await terminalView(page);
  const cell = Math.max(8, Math.round(view.cellHeight));

  // Run the ownership checks in a mouse-reporting TUI: xterm's native touch
  // scroll is inert there, so any byte or local movement would be this
  // handler claiming a gesture it does not own.
  await emit(page, '\x1b[?1000h\x1b[?1006h');
  await page.waitForTimeout(150);
  expect((await terminalView(page)).mouseTrackingMode).not.toBe('none');
  await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
  const before = (await terminalView(page)).viewportY;

  // A horizontal drag belongs to the pager/selection: no wheel report.
  await dispatchTouch(page, 'touchstart', [[view.centerX, view.centerY]]);
  await dispatchTouch(page, 'touchmove', [[view.centerX + 60, view.centerY + 3]]);
  // The axis stays locked: a later vertical move cannot steal the gesture.
  await dispatchTouch(page, 'touchmove', [[view.centerX + 60, view.centerY + 2 * cell]]);
  await page.waitForTimeout(100);
  expect(await sentFrames(page), 'horizontal gestures produce no wheel input').toEqual([]);
  expect((await terminalView(page)).viewportY).toBe(before);

  // A second finger is a page gesture (pinch/selection), never a scroll.
  await dispatchTouch(page, 'touchstart', [[view.centerX, view.centerY], [view.centerX + 80, view.centerY]]);
  await dispatchTouch(page, 'touchmove', [
    [view.centerX, view.centerY + 2 * cell],
    [view.centerX + 80, view.centerY + 2 * cell],
  ]);
  await page.waitForTimeout(100);
  expect(await sentFrames(page), 'multitouch produces no wheel input').toEqual([]);
  expect((await terminalView(page)).viewportY).toBe(before);

  // A tap has no move to claim, and a sub-slop jitter is not a drag.
  await dispatchTouch(page, 'touchstart', [[view.centerX, view.centerY]]);
  await dispatchTouch(page, 'touchmove', [[view.centerX, view.centerY + 2]]);
  await page.waitForTimeout(100);
  expect(await sentFrames(page), 'a tap produces no wheel input').toEqual([]);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': with mouse reporting on, a horizontal drag and its ' +
      'locked vertical continuation, a two-finger move and a sub-slop tap produced no wheel ' +
      'report, no PTY bytes and no local history movement; the swipe-pager suite runs in the ' +
      'runtime half',
  });
});
