'use strict';
// #2710 SC-11: the expanded Capsule offers a reversible *scroll range*, not
// an automatic screen push that permanently clips the original first rows.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime, command } = require('../../../shared/foreground-resume-browser.cjs');
const {
  dismissCapability, moveOverTerminal, openCapability, openSession, paneSize, terminalGeometry,
} = require('../../../shared/terminal-tools-browser.cjs');
const { dragTerminalRows, settleTerminalFrames } = require('../../../shared/terminal-touch-scroll-cases.cjs');

test('SC-11: + panel never traps the first rows, including zero-scrollback terminals', async ({ page }) => {
  test.setTimeout(300_000);
  const { runtime, sha } = verifiedRuntime('SC-11');
  const name = await openSession(page, expect, runtime, 'case-2710-sc11');
  await command(page, 'seq 1 300');
  await expect.poll(async () => (await terminalGeometry(page))?.baseY ?? 0, {
    timeout: 20_000,
  }).toBeGreaterThan(80);
  const start = await terminalGeometry(page);
  // The initial attach may still be settling a debounced resize; measure only
  // after the pane reports the same size twice, as the other #2710 cases do.
  let paneReading = '';
  await expect.poll(async () => {
    const next = paneSize(runtime, name);
    const settled = next === paneReading;
    paneReading = next;
    return settled;
  }, { timeout: 20_000, intervals: [500] }).toBe(true);
  const paneBefore = paneReading;
  await openCapability(page, expect, 'terminal-keys');
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance ?? 0, {
    timeout: 10_000,
  }).toBeGreaterThan(0);
  await settleTerminalFrames(page);
  const opened = await terminalGeometry(page);
  expect(opened.screenTransform, 'opening + must not push any original top row away')
    .toBe('none');
  expect(opened.viewportY, 'opening + keeps the current xterm anchor').toBe(start.viewportY);
  expect(opened.rows, 'expanded-panel clearance never changes rows').toBe(start.rows);

  // Explicit forward scrolling spends the virtual tail clearance so that the
  // latest line is above the panel. Reverse scrolling must undo the visual pan
  // and then reach real history all the way to viewportY=0.
  await moveOverTerminal(page);
  await page.mouse.wheel(0, 20000);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, {
    timeout: 10_000,
  }).toBe('following');
  const live = await terminalGeometry(page);
  expect(live.screenTransform).not.toBe('none');
  expect(live.cursorBottom).toBeLessThanOrEqual(live.dockTop + 1);

  await dragTerminalRows(page, 1);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, {
    timeout: 10_000,
  }).toBe('history');
  const firstReverse = await terminalGeometry(page);
  expect(firstReverse.screenTransform, 'the first backward drag recovers screen headroom')
    .not.toBe(live.screenTransform);

  await moveOverTerminal(page);
  await page.mouse.wheel(0, -20000);
  await expect.poll(async () => {
    const v = await terminalGeometry(page);
    return v?.screenTransform === 'none' && v.viewportY === 0;
  }, { timeout: 10_000 }).toBe(true);
  const oldest = await terminalGeometry(page);
  expect(oldest.rows).toBe(start.rows);
  expect(paneSize(runtime, name)).toBe(paneBefore);

  await moveOverTerminal(page);
  await page.mouse.wheel(0, 20000);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, {
    timeout: 10_000,
  }).toBe('following');
  await dismissCapability(page, expect);
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance ?? -1, {
    timeout: 10_000,
  }).toBe(0);

  // The public xterm API clears only local scrollback, not the tmux/PTY pane.
  // This proves the visual pan is reversible even if there are NO prior lines
  // to scroll into. A fixed translateY could never satisfy this case.
  await page.evaluate(() => {
    const mount = document.querySelector('[data-terminal-viewport] .xterm')?.parentElement;
    const term = mount?.xtermInstance;
    if (!term || typeof term.clear !== 'function') {
      throw Error('real xterm instance not accessible');
    }
    term.clear();
  });
  await expect.poll(async () => (await terminalGeometry(page))?.baseY ?? -1, {
    timeout: 10_000,
  }).toBe(0);
  await openCapability(page, expect, 'terminal-keys');
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance ?? 0, {
    timeout: 10_000,
  }).toBeGreaterThan(0);
  await settleTerminalFrames(page);
  const noHistory = await terminalGeometry(page);
  expect(noHistory.screenTransform, 'zero scrollback: original top remains visible').toBe('none');
  expect(noHistory.baseY).toBe(0);

  await moveOverTerminal(page);
  await page.mouse.wheel(0, 12000);
  await expect.poll(async () => (await terminalGeometry(page))?.screenTransform, {
    timeout: 10_000,
  }).not.toBe('none');
  const panned = await terminalGeometry(page);
  expect(panned.baseY).toBe(0);

  await dragTerminalRows(page, 2);
  await expect.poll(async () => (await terminalGeometry(page))?.screenTransform, {
    timeout: 10_000,
  }).not.toBe(panned.screenTransform);
  await moveOverTerminal(page);
  await page.mouse.wheel(0, -12000);
  await expect.poll(async () => (await terminalGeometry(page))?.screenTransform, {
    timeout: 10_000,
  }).toBe('none');
  const restored = await terminalGeometry(page);
  expect(restored.baseY, 'the top is reachable with no xterm scrollback').toBe(0);
  expect(restored.rows).toBe(start.rows);
  expect(paneSize(runtime, name)).toBe(paneBefore);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': panel open preserved original origin; wheel reached live ' +
      live.screenTransform + ', reversed to top at ydisp=' + oldest.viewportY +
      '; zero-history buffer baseY=' + restored.baseY + ' panned and restored the top; ' +
      'xterm rows=' + restored.rows + ', PTY pane=' + paneBefore + ' unchanged',
  });
});
