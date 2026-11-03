'use strict';
// #2659 SC-02: mouse-reporting and alternate-screen applications receive the
// drag through xterm's own mode semantics — the same wheel path a desktop
// mouse takes — instead of the handler returning without doing anything.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { emit, sentFrames } = require('../../../shared/terminal-clipboard-cases.cjs');
const {
  dispatchTouch, fillScrollback, openScrollFixture, terminalView,
} = require('../../../shared/terminal-touch-scroll-cases.cjs');

test('SC-02: mouse and alternate-screen TUIs get the drag through xterm semantics', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-02');
  await openScrollFixture(page);
  await fillScrollback(page, 80);

  const view = await terminalView(page);
  const cell = Math.max(8, Math.round(view.cellHeight));

  // 1. Mouse reporting: the drag becomes the standard SGR wheel report.
  await emit(page, '\x1b[?1000h\x1b[?1006h');
  await page.waitForTimeout(150);
  expect((await terminalView(page)).mouseTrackingMode).not.toBe('none');
  await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
  await dispatchTouch(page, 'touchstart', [[view.centerX, view.centerY]]);
  await dispatchTouch(page, 'touchmove', [[view.centerX, view.centerY + cell]]);
  // A downward finger is wheel-up (button 64) in SGR coordinates.
  await expect.poll(async () => (await sentFrames(page)).join(''))
    .toMatch(/\x1b\[<64;\d+;\d+M$/);
  const mouseFrames = await sentFrames(page);
  expect(mouseFrames.join(''), 'only the wheel report is produced')
    .toMatch(/^(\x1b\[<64;\d+;\d+M)+$/);

  // 2. Alternate screen (no mouse): xterm's answer for a wheel with no
  //    scrollback is the arrow key for the direction, not a local scroll.
  await emit(page, '\x1b[?1000l\x1b[?1006l\x1b[?1049h');
  await page.waitForTimeout(200);
  const alternate = await terminalView(page);
  expect(alternate.type).toBe('alternate');
  await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
  await dispatchTouch(page, 'touchstart', [[view.centerX, view.centerY]]);
  await dispatchTouch(page, 'touchmove', [[view.centerX, view.centerY + cell]]);
  await expect.poll(async () => (await sentFrames(page)).join('')).toBe('\x1b[A');
  expect((await terminalView(page)).viewportY,
    'the alternate screen has no local history to scroll').toBe(alternate.viewportY);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': with SGR mouse tracking on, a ' + cell + 'px downward ' +
      'drag produced the wheel-up mouse report and nothing else; in the alternate screen the same ' +
      'drag produced xterm’s wheel answer for a no-scrollback buffer (ESC [ A) and moved no local ' +
      'history',
  });
});
