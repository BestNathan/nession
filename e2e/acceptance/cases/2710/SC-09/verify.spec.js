'use strict';
// #2710 SC-09: the clearance changes no grid/PTY/tmux dimension, does not
// shift alternate-screen or mouse-reporting applications, keeps touch scrolling
// and the #2657 direction pad working, and does not disturb the attachment.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime, command, readBuffer } = require('../../../shared/foreground-resume-browser.cjs');
const {
  markTerminal, openCapability, openSession, paneSize, stopPtyProbe, terminalGeometry,
} = require('../../../shared/terminal-tools-browser.cjs');
const {
  dragTerminalRows, settleTerminalFrames,
} = require('../../../shared/terminal-touch-scroll-cases.cjs');
const {
  touchStart, touchMove, touchEnd,
} = require('../../../shared/terminal-direction-pad-cases.cjs');

test('SC-09: dimensions, alternate screen, mouse TUI, touch scroll and direction pad', async ({ page }) => {
  test.setTimeout(300_000);
  const { runtime, sha } = verifiedRuntime('SC-09');
  const name = await openSession(page, expect, runtime, 'case-2710-sc09');
  await markTerminal(page);

  // App fits 96 fixed columns, so the grid is tall; a short `seq` would leave
  // no scrollback at 390px.
  await command(page, 'seq 1 300');
  await expect.poll(async () => (await terminalGeometry(page))?.baseY ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(50);

  // The viewport change from the desktop create/attach flow reaches tmux
  // through the controller's debounced resize. Capture the settled pane size
  // as the baseline, not the pre-resize one, or opening the panel looks like a
  // resize when the first fit lands late.
  let paneReading = '';
  await expect.poll(async () => {
    const next = paneSize(runtime, name);
    const settled = next === paneReading;
    paneReading = next;
    return settled;
  }, { timeout: 20_000, intervals: [500] }).toBe(true);
  const paneBefore = paneReading;
  const before = await terminalGeometry(page);
  await openCapability(page, expect, 'terminal-keys');
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(0);
  // Let the panel-opening follow reconciliation settle before the gesture.
  await expect.poll(async () => {
    const view = await terminalGeometry(page);
    return view?.mode === 'following' && view.viewportY === view.baseY;
  }, { timeout: 10_000 }).toBe(true);
  const shifted = await terminalGeometry(page);
  expect(shifted.rows).toBe(before.rows);
  expect(shifted.occlusion).toBe(before.occlusion);
  expect(paneSize(runtime, name)).toBe(paneBefore);

  // Touch scrolling is still terminal-owned while the panel is open. Aim at
  // the terminal well's top: the shifted grid is tall and the panel covers its
  // middle at App width. Let the panel-open follow reconciliation settle
  // first, then drag several cells so a fractional cell height cannot round
  // the gesture to zero lines.
  await settleTerminalFrames(page);
  await dragTerminalRows(page, 1);
  await expect.poll(async () => {
    const view = await terminalGeometry(page);
    return view ? view.baseY - view.viewportY : 0;
  }, { timeout: 10_000, message: 'the touch drag did not move local history' }).toBeGreaterThan(0);
  const scrolled = await terminalGeometry(page);
  expect(scrolled.viewportY).toBeLessThan(scrolled.baseY);
  expect(scrolled.screenTransform, 'the drag retains the live panel shift')
    .toBe(shifted.screenTransform);

  // Alternate-screen application: no shift, no resize, no changed rows.
  await page.getByTestId('capsule-capability-dismiss').click();
  await command(page, 'sh pty-probe.sh altscreen');
  await expect.poll(async () => (await readBuffer(page)).includes('PTY-PROBE READY altscreen'), {
    timeout: 20_000,
  }).toBe(true);
  await openCapability(page, expect, 'terminal-keys');
  await expect.poll(async () => (await terminalGeometry(page))?.bufferType, { timeout: 10_000 })
    .toBe('alternate');
  const alternate = await terminalGeometry(page);
  expect(alternate.screenTransform, 'alternate screen must not be shifted').toBe('none');
  expect(alternate.rows).toBe(before.rows);
  expect(paneSize(runtime, name)).toBe(paneBefore);

  // Mouse-reporting TUI: the same rule, from the mode the terminal tracks.
  await page.getByTestId('capsule-capability-dismiss').click();
  await stopPtyProbe(page);
  await command(page, 'sh pty-probe.sh mouse-sgr');
  await expect.poll(async () => (await readBuffer(page)).includes('PTY-PROBE READY mouse-sgr'), {
    timeout: 20_000,
  }).toBe(true);
  await openCapability(page, expect, 'terminal-keys');
  const mouse = await terminalGeometry(page);
  expect(mouse.mouseTrackingMode).not.toBe('none');
  expect(mouse.screenTransform, 'mouse-reporting TUI must not be shifted').toBe('none');
  expect(mouse.rows).toBe(before.rows);
  expect(paneSize(runtime, name)).toBe(paneBefore);

  // #2657 direction pad still emits the semantic arrow while the panel is up.
  await page.getByTestId('capsule-capability-dismiss').click();
  await stopPtyProbe(page);
  await command(page, 'sh pty-probe.sh normal');
  await expect.poll(async () => (await readBuffer(page)).includes('PTY-PROBE READY normal'), {
    timeout: 20_000,
  }).toBe(true);
  await openCapability(page, expect, 'terminal-keys');
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(0);
  // A stationary hold needs room above the start point for an "up" direction,
  // so sit lower than `terminalPoint` while staying above the panel.
  const padPoint = await page.evaluate(() => {
    const host = document.querySelector('[data-terminal-capsule-host]');
    const dock = document.querySelector('[data-testid="terminal-capsule"]');
    const screen = document.querySelector('.xterm-screen');
    if (!(host instanceof HTMLElement) || !(dock instanceof HTMLElement) ||
        !(screen instanceof HTMLElement)) return null;
    const hostBox = host.getBoundingClientRect();
    const dockBox = dock.getBoundingClientRect();
    const screenBox = screen.getBoundingClientRect();
    return {
      x: Math.round(screenBox.left + screenBox.width / 2),
      y: Math.round(Math.min(dockBox.top - 80, Math.max(hostBox.top + 120, screenBox.top + 120))),
    };
  });
  if (!padPoint) throw new Error('direction-pad point unavailable');
  const beforePad = await readBuffer(page);
  await touchStart(page, padPoint);
  await page.waitForTimeout(500);
  await touchMove(page, { x: padPoint.x, y: padPoint.y - 40 });
  await expect.poll(async () => (await readBuffer(page)).includes('^[[A'), { timeout: 10_000 })
    .toBe(true);
  await touchEnd(page, { x: padPoint.x, y: padPoint.y - 40 });
  expect(beforePad.includes('^[[A')).toBe(false);

  // The Session is still attached and the xterm node is the one we marked.
  await expect(page.getByTestId('terminal-connecting')).toBeHidden();
  expect(await page.locator('.xterm[data-2710-terminal="original"]').count()).toBe(1);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': panel open with rows=' + before.rows + ' and pane ' +
      paneBefore + ' (unchanged); touch drag entered history at viewportY=' + scrolled.viewportY +
      '; alternate-screen and mouse-sgr rendered transform ' + alternate.screenTransform + '; ' +
      'direction pad emitted ^[[A while the panel was open; xterm node survived',
  });
});
