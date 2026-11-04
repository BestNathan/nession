'use strict';
// #2710 SC-09: the clearance changes no grid/PTY/tmux dimension, does not
// shift alternate-screen or mouse-reporting applications, keeps touch scrolling
// and the #2657 direction pad working, and does not disturb the attachment.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime, command, readBuffer } = require('../../../shared/foreground-resume-browser.cjs');
const {
  markTerminal, openCapability, openSession, paneSize, stopPtyProbe, terminalGeometry,
  terminalPoint,
} = require('../../../shared/terminal-tools-browser.cjs');
const { dispatchTouch, terminalView } = require('../../../shared/terminal-touch-scroll-cases.cjs');
const {
  touchStart, touchMove, touchEnd,
} = require('../../../shared/terminal-direction-pad-cases.cjs');

test('SC-09: dimensions, alternate screen, mouse TUI, touch scroll and direction pad', async ({ page }) => {
  test.setTimeout(300_000);
  const { runtime, sha } = verifiedRuntime('SC-09');
  const name = await openSession(page, expect, runtime, 'case-2710-sc09');
  await markTerminal(page);
  const paneBefore = paneSize(runtime, name);

  // App fits 96 fixed columns, so the grid is tall; a short `seq` would leave
  // no scrollback at 390px.
  await command(page, 'seq 1 300');
  await expect.poll(async () => (await terminalGeometry(page))?.baseY ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(50);
  const before = await terminalGeometry(page);
  await openCapability(page, expect, 'terminal-keys');
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const shifted = await terminalGeometry(page);
  expect(shifted.rows).toBe(before.rows);
  expect(shifted.occlusion).toBe(before.occlusion);
  expect(paneSize(runtime, name)).toBe(paneBefore);

  // Touch scrolling is still terminal-owned while the panel is open. Aim at
  // the terminal well's top: the shifted grid is tall and the panel covers its
  // middle at App width.
  const view = await terminalView(page);
  const point = await terminalPoint(page);
  await dispatchTouch(page, 'touchstart', [[point.x, point.y]]);
  await dispatchTouch(page, 'touchmove', [[point.x, point.y + 4]]);
  await dispatchTouch(page, 'touchmove', [[point.x, point.y + 4 + Math.round(view.cellHeight)]]);
  await dispatchTouch(page, 'touchend', []);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, { timeout: 10_000 })
    .toBe('history');
  const scrolled = await terminalGeometry(page);
  expect(scrolled.viewportY).toBeLessThan(scrolled.baseY);
  expect(scrolled.screenTransform, 'history is unshifted').toBe('none');

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
