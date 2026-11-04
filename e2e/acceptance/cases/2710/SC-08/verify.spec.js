'use strict';
// #2710 SC-08: opening +, Keys or Commands makes the live bottom reach just
// above the highest open surface; history keeps its anchor; closing restores
// composer-only clearance. Rows, PTY and tmux size never move.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime, command } = require('../../../shared/foreground-resume-browser.cjs');
const {
  dismissCapability, moveOverTerminal, openSession, paneSize, terminalGeometry,
} = require('../../../shared/terminal-tools-browser.cjs');

// App fits 96 fixed columns, so the grid is tall and a smaller line count would
// not produce scrollback at all.
const SCROLL = 'seq 1 400';

test('SC-08: live clearance, history anchor and composer-only restore', async ({ page }) => {
  test.setTimeout(240_000);
  const { runtime, sha } = verifiedRuntime('SC-08');
  const name = await openSession(page, expect, runtime, 'case-2710-sc08');
  await command(page, SCROLL);
  await expect.poll(async () => (await terminalGeometry(page))?.baseY ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(100);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, { timeout: 10_000 })
    .toBe('following');

  const before = await terminalGeometry(page);
  const paneBefore = paneSize(runtime, name);
  const occlusion = before.occlusion;
  const shell = before.shellBox;
  if (!before.occlusion) throw new Error('the composer occlusion must be published');

  const assertClear = async (label) => {
    await expect.poll(async () => (await terminalGeometry(page))?.panelClearance ?? 0, {
      timeout: 10_000,
      message: label + ' clearance did not publish',
    }).toBeGreaterThan(0);
    const view = await terminalGeometry(page);
    expect(view.mode, label + ' stays following').toBe('following');
    expect(view.viewportY, label + ' stays at the live bottom').toBe(view.baseY);
    expect(view.screenTransform, label + ' shifts the rendered screen').not.toBe('none');
    expect(view.cursorBottom, label + ': latest output above the panel')
      .toBeLessThanOrEqual(view.dockTop + 1);
    expect(view.cursorLine.length, label + ': the cursor line is real output').toBeGreaterThan(0);
    // The fit contract and the dimensions are untouched.
    expect(view.occlusion, label + ': fit occlusion unchanged').toBe(occlusion);
    expect(view.rows, label + ': xterm rows unchanged').toBe(before.rows);
    expect(paneSize(runtime, name), label + ': pane size unchanged').toBe(paneBefore);
    expect(view.shellBox, label + ': composer unchanged').toEqual(shell);
    return view;
  };

  // `+` itself is an upper surface; Keys and Commands change its height.
  await page.getByTestId('capsule-capability-more').click();
  await expect(page.getByTestId('capsule-context-disclosure')).toBeVisible();
  await assertClear('+');
  // The list is already open; selecting a row deepens the same slot (clicking
  // `+` again would close it).
  await page.getByTestId('capsule-context-item-terminal-keys')
    .or(page.getByTestId('capsule-capability-picker-terminal-keys')).first().click();
  await expect(page.getByTestId('capsule-capability-projection')).toBeVisible();
  await assertClear('Keys');
  await page.getByTestId('capsule-view-quick-commands').click();
  await expect(page.getByTestId('quick-commands-body')).toBeVisible();
  await assertClear('Commands');

  // History: scrolling up keeps the anchor across a panel height change.
  await moveOverTerminal(page);
  await page.mouse.wheel(0, -320);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, { timeout: 10_000 })
    .toBe('history');
  const history = await terminalGeometry(page);
  expect(history.screenTransform, 'history applies no shift').toBe('none');
  expect(history.viewportY).toBeLessThan(history.baseY);

  await page.getByTestId('capsule-view-terminal-keys').click();
  await expect(page.getByTestId('terminal-keys-body')).toBeVisible();
  const afterResize = await terminalGeometry(page);
  expect(afterResize.viewportY, 'history anchor survives a panel height change')
    .toBe(history.viewportY);
  expect(afterResize.screenTransform, 'history still applies no shift').toBe('none');

  // Scroll to the live bottom: following returns and the clearance reapplies.
  // Re-aim after the view switch moved the screen under the pointer.
  await moveOverTerminal(page);
  await page.mouse.wheel(0, 20000);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, { timeout: 10_000 })
    .toBe('following');
  const restored = await terminalGeometry(page);
  expect(restored.cursorBottom).toBeLessThanOrEqual(restored.dockTop + 1);

  // Closing from history restores composer-only clearance without a scroll.
  await moveOverTerminal(page);
  await page.mouse.wheel(0, -320);
  await expect.poll(async () => (await terminalGeometry(page))?.mode, { timeout: 10_000 })
    .toBe('history');
  const browsing = await terminalGeometry(page);
  await dismissCapability(page, expect);
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance ?? -1, {
    timeout: 10_000,
  }).toBe(0);
  const closed = await terminalGeometry(page);
  expect(closed.viewportY, 'closing preserves the browsing position').toBe(browsing.viewportY);
  expect(closed.screenTransform, 'closing removes the shift').toBe('none');
  expect(closed.occlusion, 'composer-only fit value remains').toBe(occlusion);
  expect(closed.rows).toBe(before.rows);
  expect(paneSize(runtime, name)).toBe(paneBefore);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': +/Keys/Commands published clearance and kept cursorBottom <= ' +
      'dockTop with unchanged xterm rows and tmux ' + paneBefore + '; history anchor viewportY=' +
      history.viewportY + ' survived a view switch; close restored 0px clearance without moving ' +
      'viewportY=' + closed.viewportY,
  });
});
