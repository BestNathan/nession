'use strict';
// #2659 SC-01: a single-finger vertical drag moves normal-buffer local
// history, without changing the PTY, and sub-cell travel accumulates instead
// of turning every high-frequency move into one line.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { sentFrames } = require('../../../shared/terminal-clipboard-cases.cjs');
const {
  dispatchTouch, fillScrollback, openScrollFixture, terminalView,
} = require('../../../shared/terminal-touch-scroll-cases.cjs');

test('SC-01: a vertical drag scrolls local history with accumulated sub-cell travel', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-01');
  await openScrollFixture(page);
  await fillScrollback(page, 120);

  const view = await terminalView(page);
  expect(view.type).toBe('normal');
  expect(view.mouseTrackingMode).toBe('none');
  expect(view.baseY, 'the fixture must have history to scroll').toBeGreaterThan(0);
  expect(view.viewportY).toBe(view.baseY);
  const cell = Math.max(8, Math.round(view.cellHeight));
  const before = await sentFrames(page);

  // One cell of finger travel (after the 8px axis slop) is exactly one line.
  await dispatchTouch(page, 'touchstart', [[view.centerX, view.centerY]]);
  await dispatchTouch(page, 'touchmove', [[view.centerX, view.centerY + 4]]);
  await dispatchTouch(page, 'touchmove', [[view.centerX, view.centerY + 4 + cell]]);
  let after = await terminalView(page);
  expect(after.viewportY, 'one cell of drag is one line of history').toBe(view.viewportY - 1);

  // Ten 4px moves are two lines, not ten: the handler accumulates pixels.
  for (let step = 1; step <= 10; step += 1) {
    await dispatchTouch(page, 'touchmove', [[view.centerX, view.centerY + 4 + cell + step * 4]]);
  }
  after = await terminalView(page);
  const moved = view.viewportY - 1 - after.viewportY;
  const expected = Math.floor((10 * 4) / cell);
  expect(moved, 'sub-cell travel accumulates into whole lines').toBe(expected);
  expect(moved, 'high-frequency moves do not jump a line each').toBeLessThan(10);

  // The PTY received nothing: local history is xterm's buffer, not input.
  expect(await sentFrames(page)).toEqual(before);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': fixture cell ' + cell + 'px, ' + view.baseY +
      ' lines of history; one cell of drag moved viewportY by exactly 1; ten 4px moves moved ' +
      expected + ' line(s); no PTY bytes were produced',
  });
});
