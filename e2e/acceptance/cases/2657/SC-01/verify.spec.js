'use strict';
// #2657 SC-01: native Touch Events arm a stationary single-finger hold and
// move the guide; a tap, an early drag, native scrolling, multi-touch and the
// App shell's edge band never produce a spurious arrow. Before arming, a
// pending touch is not consumed by the pad.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openDirectionPadFixture, terminalView, fillScrollback,
  touchStart, touchMove, touchEnd, secondFinger,
  padState, sentBytes, clearSent, annotate,
} = require('../../../shared/terminal-direction-pad-cases.cjs');

test('SC-01: touch arming, native gestures and the App edge band', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-01');

  await openDirectionPadFixture(page);
  const view = await terminalView(page);

  // A tap is not a hold: no guide, no bytes, after a full hold window.
  await clearSent(page);
  await touchStart(page, { x: view.centerX, y: view.centerY });
  await touchEnd(page, { x: view.centerX, y: view.centerY });
  await page.waitForTimeout(500);
  expect((await padState(page)).present).toBe(false);
  expect(await sentBytes(page)).toBe('');

  // A quick horizontal drag is still native before the hold elapses.
  await touchStart(page, { x: view.centerX, y: view.centerY });
  const earlyDragPrevented = await touchMove(page, { x: view.centerX + 60, y: view.centerY });
  await touchEnd(page, { x: view.centerX + 60, y: view.centerY });
  await page.waitForTimeout(500);
  expect((await padState(page)).present).toBe(false);
  expect(earlyDragPrevented).toBe(false);
  expect(await sentBytes(page)).toBe('');

  // A quick vertical swipe scrolls history before arming and sends nothing.
  await fillScrollback(page, 120);
  const beforeScroll = await terminalView(page);
  expect(beforeScroll.baseY).toBeGreaterThan(0);
  await clearSent(page);
  await touchStart(page, { x: beforeScroll.centerX, y: beforeScroll.centerY });
  await touchMove(page, { x: beforeScroll.centerX, y: beforeScroll.centerY + 64 });
  await touchEnd(page, { x: beforeScroll.centerX, y: beforeScroll.centerY + 64 });
  expect((await padState(page)).present).toBe(false);
  expect(await sentBytes(page)).toBe('');
  await expect.poll(async () => (await terminalView(page)).viewportY, { timeout: 10_000 })
    .toBeLessThan(beforeScroll.viewportY);

  // A stationary hold arms; a 12px move stays in the centre dead zone.
  const armedView = await terminalView(page);
  await clearSent(page);
  await touchStart(page, { x: armedView.centerX, y: armedView.centerY });
  await page.waitForTimeout(450);
  await expect.poll(async () => (await padState(page)).present, { timeout: 10_000 })
    .toBe(true);
  let state = await padState(page);
  expect(state.phase).toBe('armed');
  expect(state.direction).toBe('none');
  expect(await sentBytes(page)).toBe('');

  await touchMove(page, { x: armedView.centerX, y: armedView.centerY - 12 });
  state = await padState(page);
  expect(state.direction).toBe('none');
  expect(await sentBytes(page)).toBe('');

  await touchMove(page, { x: armedView.centerX, y: armedView.centerY - 40 });
  await expect.poll(async () => (await padState(page)).direction, { timeout: 10_000 })
    .toBe('up');
  expect(await sentBytes(page)).toBe('\x1b[A');
  await touchEnd(page, { x: armedView.centerX, y: armedView.centerY - 40 });
  await expect.poll(async () => (await padState(page)).present, { timeout: 10_000 })
    .toBe(false);

  // A second finger interrupts the armed pad without an arrow.
  const multiView = await terminalView(page);
  await clearSent(page);
  await touchStart(page, { x: multiView.centerX, y: multiView.centerY });
  await page.waitForTimeout(450);
  expect((await padState(page)).present).toBe(true);
  await secondFinger(
    page,
    { x: multiView.centerX, y: multiView.centerY },
    { x: multiView.centerX + 50, y: multiView.centerY },
  );
  await expect.poll(async () => (await padState(page)).present, { timeout: 10_000 })
    .toBe(false);
  await page.waitForTimeout(500);
  expect(await sentBytes(page)).toBe('');
  await touchEnd(page, { x: multiView.centerX, y: multiView.centerY });

  // The App shell's 28px edge band is shell navigation's: no pad there. The
  // same hold in the interior still arms.
  await openDirectionPadFixture(page, { appShell: true });
  const appView = await terminalView(page);
  const shell = await page.evaluate(() => {
    const element = document.querySelector('[data-experience="app"]');
    if (!element) throw new Error('the App shell is not present');
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right };
  });
  await clearSent(page);
  await touchStart(page, { x: shell.left + 8, y: appView.centerY });
  await page.waitForTimeout(500);
  expect((await padState(page)).present).toBe(false);
  expect(await sentBytes(page)).toBe('');
  await touchEnd(page, { x: shell.left + 8, y: appView.centerY });

  await touchStart(page, { x: appView.centerX, y: appView.centerY });
  await page.waitForTimeout(450);
  await expect.poll(async () => (await padState(page)).present, { timeout: 10_000 })
    .toBe(true);
  expect((await padState(page)).phase).toBe('armed');
  await touchEnd(page, { x: appView.centerX, y: appView.centerY });

  annotate(
    testInfo,
    sha,
    'tap, early horizontal drag, native vertical scroll and multi-touch produced no PTY bytes; '
    + 'a 380ms hold armed with direction none, a 12px move stayed in the dead zone, a 40px move '
    + 'sent exactly ESC[A; an App-shell edge-band touch did not arm while the same hold in the '
    + 'interior did',
  );
});
