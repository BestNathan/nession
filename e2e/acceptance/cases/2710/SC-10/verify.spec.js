'use strict';
// #2710 SC-10: expanded Capsule navigation must remain continuous between
// the unshifted first row, real xterm history and the manually revealed live
// prompt above the panel. Alternate/mouse TUI screens and PTY size stay stable.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime, command } = require('../../../shared/foreground-resume-browser.cjs');
const {
  dismissCapability, markTerminal, moveOverTerminal, openCapability, openSession, paneSize,
  startPtyProbe, stopPtyProbe, terminalGeometry,
} = require('../../../shared/terminal-tools-browser.cjs');
const {
  dragTerminalRows, settleTerminalFrames,
} = require('../../../shared/terminal-touch-scroll-cases.cjs');

const SCROLL = 'seq 1 400';

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

  // 1. Opening + / Keys must preserve the Terminal's original top rows.
  await openCapability(page, expect, 'terminal-keys');
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance ?? 0, {
    timeout: 10_000,
  }).toBeGreaterThan(0);
  await settleTerminalFrames(page);
  const opening = await terminalGeometry(page);
  expect(opening.screenTransform, 'opening the panel must not automatically push the grid')
    .toBe('none');
  expect(opening.viewportY, 'opening the panel preserves the buffer position')
    .toBe(opening.baseY);

  // 2. The first backward drag browses real history without clipping the top.
  await dragTerminalRows(page, 2);
  await expect.poll(async () => {
    const view = await terminalGeometry(page);
    return view ? view.mode === 'history' && view.viewportY < view.baseY : false;
  }, { timeout: 10_000 }).toBe(true);
  const first = await terminalGeometry(page);
  expect(first.screenTransform, 'history starts at the original grid origin').toBe('none');

  await dragTerminalRows(page, 3);
  await expect.poll(async () => (await terminalGeometry(page))?.viewportY).toBeLessThan(
    first.viewportY,
  );
  const deeper = await terminalGeometry(page);
  expect(deeper.screenTransform).toBe('none');

  await dragTerminalRows(page, -2);
  await expect.poll(async () => (await terminalGeometry(page))?.viewportY).toBeGreaterThan(
    deeper.viewportY,
  );
  const back = await terminalGeometry(page);
  expect(back.screenTransform).toBe('none');

  // 3. The forward wheel path reaches the latest output above the panel.
  await moveOverTerminal(page);
  await page.mouse.wheel(0, 20000);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, { timeout: 10_000 })
    .toBe('following');
  const shifted = await terminalGeometry(page);
  expect(shifted.screenTransform, 'the user can spend the extra scrollroom').not.toBe('none');
  expect(shifted.cursorBottom, 'the latest output is above the open panel')
    .toBeLessThanOrEqual(shifted.dockTop + 1);

  // One reverse wheel step *reduces* the visual pan, rather than pinning
  // a full-height shift that hides the first rows forever.
  await moveOverTerminal(page);
  await page.mouse.wheel(0, -320);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, { timeout: 10_000 })
    .toBe('history');
  const wheelHistory = await terminalGeometry(page);
  expect(wheelHistory.screenTransform, 'a reverse step reclaims clipped top rows')
    .not.toBe(shifted.screenTransform);
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
  await settleTerminalFrames(page);

  await dragTerminalRows(page, 1);
  await expect.poll(async () => (await terminalGeometry(page))?.viewportY).toBeLessThan(
    readerPanel.viewportY,
  );
  const readerDeeper = await terminalGeometry(page);
  await dragTerminalRows(page, -1);
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
    description: 'exact SHA ' + sha + ': + opened unshifted at viewportY=' +
      opening.viewportY + ', touch history reached ' + deeper.viewportY +
      ' and returned to ' + back.viewportY + '; manual wheel spent ' +
      shifted.panelClearance + 'px of reversible scrollroom and recovered part of it (' +
      wheelHistory.screenTransform + '); history anchor ' + reader.viewportY +
      ', alternate/mouse unchanged, pane ' + paneBefore + ', xterm node retained',
  });
});
