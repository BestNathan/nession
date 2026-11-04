'use strict';
// #2710 SC-10: with a Capsule panel open, scrolling from live-following into
// history must not move the rendered screen back under the panel. Further
// drags continue browsing both ways, opening the panel while already reading
// history keeps the anchor, and TUI/mouse modes keep their unshifted screen
// with unchanged xterm rows and tmux pane size.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime, command } = require('../../../shared/foreground-resume-browser.cjs');
const {
  dismissCapability, markTerminal, moveOverTerminal, openCapability, openSession, paneSize,
  startPtyProbe, stopPtyProbe, terminalGeometry, terminalPoint,
} = require('../../../shared/terminal-tools-browser.cjs');
const { dispatchTouch, terminalView } = require('../../../shared/terminal-touch-scroll-cases.cjs');

const SCROLL = 'seq 1 400';

/**
 * One real-gesture drag. Positive rows move the finger down and browse older
 * output; negative rows move it up and return toward the live bottom. The
 * initial 4px stays inside the axis slop, mirroring SC-09.
 */
async function dragRows(page, rows) {
  const view = await terminalView(page);
  const point = await terminalPoint(page);
  // Cell height is fractional; round up and add a small buffer so the gesture
  // always crosses at least `rows` whole lines on either direction.
  const distance = Math.ceil(view.cellHeight * Math.abs(rows)) + 2;
  const direction = rows > 0 ? 1 : -1;
  // Upward drags start lower so the whole gesture stays on the visible screen.
  const startY = direction > 0 ? point.y : point.y + 4 + distance;
  await dispatchTouch(page, 'touchstart', [[point.x, startY]]);
  await dispatchTouch(page, 'touchmove', [[point.x, startY + direction * 4]]);
  await dispatchTouch(page, 'touchmove', [[point.x, startY + direction * (4 + distance)]]);
  await dispatchTouch(page, 'touchend', []);
}

test('SC-10: continuous scrollback browsing under an expanded panel', async ({ page }) => {
  test.setTimeout(300_000);
  const { runtime, sha } = verifiedRuntime('SC-10');
  const name = await openSession(page, expect, runtime, 'case-2710-sc10');
  await markTerminal(page);
  await command(page, SCROLL);
  await expect.poll(async () => (await terminalGeometry(page))?.baseY ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(100);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, { timeout: 10_000 })
    .toBe('following');

  // The desktop create/attach viewport reaches tmux through the controller's
  // debounced resize; record the settled pane size as the baseline.
  let paneReading = '';
  await expect.poll(async () => {
    const next = paneSize(runtime, name);
    const settled = next === paneReading;
    paneReading = next;
    return settled;
  }, { timeout: 20_000, intervals: [500] }).toBe(true);
  const paneBefore = paneReading;
  const resting = await terminalGeometry(page);

  // 1. Panel open while following: the live bottom shifts above the panel.
  await openCapability(page, expect, 'terminal-keys');
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance ?? 0, {
    timeout: 10_000,
  }).toBeGreaterThan(0);
  await expect.poll(async () => {
    const view = await terminalGeometry(page);
    return view?.mode === 'following' && view.viewportY === view.baseY;
  }, { timeout: 10_000 }).toBe(true);
  const shifted = await terminalGeometry(page);
  expect(shifted.screenTransform, 'following spends the panel clearance').not.toBe('none');

  // 2. The first drag into history must retain that shift, then keep browsing.
  await dragRows(page, 2);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, { timeout: 10_000 })
    .toBe('history');
  const first = await terminalGeometry(page);
  expect(first.viewportY, 'the first drag left the live bottom').toBeLessThan(first.baseY);
  expect(first.screenTransform, 'the first history step retains the live shift')
    .toBe(shifted.screenTransform);

  await dragRows(page, 3);
  await expect.poll(async () => (await terminalGeometry(page))?.viewportY).toBeLessThan(
    first.viewportY,
  );
  const deeper = await terminalGeometry(page);
  expect(deeper.screenTransform, 'further drags keep the same shift')
    .toBe(shifted.screenTransform);

  await dragRows(page, -2);
  await expect.poll(async () => (await terminalGeometry(page))?.viewportY).toBeGreaterThan(
    deeper.viewportY,
  );
  const back = await terminalGeometry(page);
  expect(back.screenTransform, 'dragging back keeps the same shift')
    .toBe(shifted.screenTransform);

  // 3. The wheel path uses the same transition rules and returns to following.
  const point = await terminalPoint(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 20000);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, { timeout: 10_000 })
    .toBe('following');
  const live = await terminalGeometry(page);
  expect(live.screenTransform, 'returning to following restores the live shift')
    .toBe(shifted.screenTransform);
  expect(live.cursorBottom, 'the latest output is above the open panel')
    .toBeLessThanOrEqual(live.dockTop + 1);

  await moveOverTerminal(page);
  await page.mouse.wheel(0, -320);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, { timeout: 10_000 })
    .toBe('history');
  const wheelHistory = await terminalGeometry(page);
  expect(wheelHistory.screenTransform, 'a wheel step into history retains the shift')
    .toBe(shifted.screenTransform);
  await moveOverTerminal(page);
  await page.mouse.wheel(0, 20000);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, { timeout: 10_000 })
    .toBe('following');

  // 4. Opening the panel while already reading history must not jump.
  await dismissCapability(page, expect);
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance ?? -1, {
    timeout: 10_000,
  }).toBe(0);
  await moveOverTerminal(page);
  await page.mouse.wheel(0, -320);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, { timeout: 10_000 })
    .toBe('history');
  const reader = await terminalGeometry(page);
  expect(reader.screenTransform, 'composer-only history is unshifted').toBe('none');

  await openCapability(page, expect, 'terminal-keys');
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance ?? 0, {
    timeout: 10_000,
  }).toBeGreaterThan(0);
  const readerPanel = await terminalGeometry(page);
  expect(readerPanel.mode, 'opening a panel does not force follow').toBe('history');
  expect(readerPanel.viewportY, 'the history anchor survives the panel opening')
    .toBe(reader.viewportY);
  expect(readerPanel.screenTransform, 'a pre-existing history reader is not shifted')
    .toBe('none');

  await dragRows(page, 1);
  await expect.poll(async () => (await terminalGeometry(page))?.viewportY).toBeLessThan(
    readerPanel.viewportY,
  );
  const readerDeeper = await terminalGeometry(page);
  await dragRows(page, -1);
  await expect.poll(async () => (await terminalGeometry(page))?.viewportY).toBeGreaterThan(
    readerDeeper.viewportY,
  );
  const browsing = await terminalGeometry(page);
  expect(browsing.screenTransform, 'browsing stays unshifted').toBe('none');

  await dismissCapability(page, expect);
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance ?? -1, {
    timeout: 10_000,
  }).toBe(0);
  const readerClosed = await terminalGeometry(page);
  expect(readerClosed.screenTransform, 'closing a history panel keeps it unshifted').toBe('none');
  expect(readerClosed.viewportY, 'closing does not move the history anchor')
    .toBe(browsing.viewportY);
  expect(paneSize(runtime, name), 'touch browsing never resizes the pane').toBe(paneBefore);

  // 5. Alternate-screen and mouse-reporting applications stay unshifted.
  await startPtyProbe(page, expect, 'altscreen');
  await openCapability(page, expect, 'terminal-keys');
  await expect.poll(async () => (await terminalGeometry(page))?.bufferType, { timeout: 10_000 })
    .toBe('alternate');
  const alternate = await terminalGeometry(page);
  expect(alternate.screenTransform, 'the alternate screen must not be shifted').toBe('none');
  expect(alternate.rows).toBe(resting.rows);
  expect(paneSize(runtime, name)).toBe(paneBefore);
  await dismissCapability(page, expect);
  await stopPtyProbe(page);

  await startPtyProbe(page, expect, 'mouse-sgr');
  await openCapability(page, expect, 'terminal-keys');
  const mouse = await terminalGeometry(page);
  expect(mouse.mouseTrackingMode).not.toBe('none');
  expect(mouse.screenTransform, 'a mouse-reporting TUI must not be shifted').toBe('none');
  expect(mouse.rows).toBe(resting.rows);
  expect(paneSize(runtime, name)).toBe(paneBefore);
  await dismissCapability(page, expect);
  await stopPtyProbe(page);

  // The same Terminal node survived every mode and panel transition.
  await expect(page.getByTestId('terminal-connecting')).toBeHidden();
  expect(await page.locator('.xterm[data-2710-terminal="original"]').count()).toBe(1);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': panel clearance ' + shifted.panelClearance +
      'px retained through following->history at viewportY=' + first.viewportY +
      ' (transform ' + first.screenTransform + '); further drags reached viewportY=' +
      deeper.viewportY + ' and returned to ' + back.viewportY +
      '; a panel opened over a history reader at viewportY=' + reader.viewportY +
      ' left it unshifted; alternate/mouse transforms ' + alternate.screenTransform +
      '/' + mouse.screenTransform + '; pane ' + paneBefore + ' unchanged; xterm node survived',
  });
});
