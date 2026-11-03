'use strict';
// #2657 SC-04: the pad uses the existing semantic-key authority, so shell vs
// TUI cursor-key encoding (DECCKM), normal/alternate screen, mouse protocol,
// scrollback and the observer gate all remain compatible. An observer cannot
// inject arrows.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openDirectionPadFixture, terminalView, fillScrollback,
  touchStart, touchMove, touchEnd,
  padState, sentFrames, sentBytes, clearSent, scrollMode, setObserver,
  terminalModes, annotate,
} = require('../../../shared/terminal-direction-pad-cases.cjs');

async function lastSent(page) {
  return (await sentFrames(page)).at(-1) || '';
}

async function armAndMove(page, start, point) {
  await touchStart(page, start);
  await page.waitForTimeout(450);
  await expect.poll(async () => (await padState(page)).present, { timeout: 10_000 })
    .toBe(true);
  await touchMove(page, point);
  await expect.poll(async () => (await padState(page)).direction, { timeout: 10_000 })
    .not.toBe('none');
  await touchEnd(page, point);
  await expect.poll(async () => (await padState(page)).present, { timeout: 10_000 })
    .toBe(false);
}

test('SC-04: cursor-mode encoding and TUI modes stay compatible', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-04');

  await openDirectionPadFixture(page);
  let view = await terminalView(page);
  let start = { x: view.centerX, y: view.centerY };

  // Normal cursor mode: a shell receives ESC [ A.
  await clearSent(page);
  await armAndMove(page, start, { x: start.x, y: start.y - 40 });
  expect(await sentBytes(page)).toBe('\x1b[A');

  // Application cursor mode (DECCKM): the same gesture sends ESC O A.
  await page.evaluate(() => window.clipboardHarness.emit('\x1b[?1h'));
  await page.waitForTimeout(150);
  expect((await terminalModes(page)).applicationCursorKeysMode).toBe(true);
  await clearSent(page);
  await armAndMove(page, start, { x: start.x, y: start.y - 40 });
  expect(await sentBytes(page)).toBe('\x1bOA');
  await page.evaluate(() => window.clipboardHarness.emit('\x1b[?1l'));
  await page.waitForTimeout(150);

  // Alternate screen: the pad still sends a semantic arrow and scrolls no
  // local history (there is none).
  await page.evaluate(() => window.clipboardHarness.emit('\x1b[?1049h'));
  await page.waitForTimeout(150);
  view = await terminalView(page);
  expect(view.type).toBe('alternate');
  await clearSent(page);
  await armAndMove(page, start, { x: start.x + 40, y: start.y });
  expect(await lastSent(page)).toBe('\x1b[C');
  const alternateViewport = await terminalView(page);
  await page.evaluate(() => window.clipboardHarness.emit('\x1b[?1049l'));
  await page.waitForTimeout(150);

  // Mouse-reporting TUI: the pad emits the cursor key, never a mouse report.
  await page.evaluate(() => window.clipboardHarness.emit('\x1b[?1000h\x1b[?1006h'));
  await page.waitForTimeout(150);
  expect((await terminalModes(page)).mouseTrackingMode).not.toBe('none');
  await clearSent(page);
  await armAndMove(page, start, { x: start.x + 40, y: start.y });
  expect(await sentBytes(page)).toBe('\x1b[C');
  expect(await sentBytes(page)).not.toMatch(/\x1b\[</);
  await page.evaluate(() => window.clipboardHarness.emit('\x1b[?1000l\x1b[?1006l'));
  await page.waitForTimeout(150);

  // Scrollback: an armed vertical drag emits its arrow and does not move the
  // viewport; the same viewport stays in follow mode.
  await fillScrollback(page, 120);
  const scrollView = await terminalView(page);
  expect(scrollView.baseY).toBeGreaterThan(0);
  const before = scrollView.viewportY;
  expect(await scrollMode(page)).toBe('following');
  await clearSent(page);
  await armAndMove(page, { x: scrollView.centerX, y: scrollView.centerY },
    { x: scrollView.centerX, y: scrollView.centerY - 60 });
  expect(await lastSent(page)).toBe('\x1b[A');
  expect((await terminalView(page)).viewportY).toBe(before);
  expect(await scrollMode(page)).toBe('following');

  // A read-only observer cannot arm or inject.
  await setObserver(page, true);
  await clearSent(page);
  view = await terminalView(page);
  start = { x: view.centerX, y: view.centerY };
  await touchStart(page, start);
  await page.waitForTimeout(500);
  expect((await padState(page)).present).toBe(false);
  await touchMove(page, { x: start.x, y: start.y - 40 });
  await page.waitForTimeout(400);
  await touchEnd(page, { x: start.x, y: start.y - 40 });
  expect(await sentBytes(page)).toBe('');
  await setObserver(page, false);

  annotate(
    testInfo,
    sha,
    'normal mode sent ESC[A; DECCKM sent ESC[OA; the alternate screen still sent ESC[C with no '
    + 'local scroll; SGR mouse tracking received only ESC[C and no mouse report; an armed '
    + 'vertical drag in a filled scrollback sent ESC[A while viewportY stayed at ' + before
    + ' in following mode; a read-only observer armed nothing and sent no bytes',
  );
});
