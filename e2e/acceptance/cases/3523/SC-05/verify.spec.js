'use strict';
// #3523 SC-05: an expanded Capsule panel keeps #2710's normal-buffer reversible
// scroll clearance and #3492's alternate-screen/mouse/TUI authorized row
// reserve or compact fallback; a concurrent keyboard avoidance session never
// double-counts panel height, never changes terminal mode routing, and never
// adds a second resize.
//
// The `+` context disclosure is used because it is the upper panel that does
// **not** own input focus (`ownsInputFocus` is false). Peeks such as Terminal
// Keys deliberately take focus and dismiss the soft keyboard, so they cannot
// coexist with a keyboard session by construction; this Case proves the
// concurrency contract where coexistence is possible.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openSession, terminalGeometry, paneSize,
} = require('../../../shared/terminal-tools-browser.cjs');
const {
  avoidanceState,
  blurActive,
  focusCapsuleComposer,
  installVisualViewportFixture,
  recordResizeRequests,
  resetVisualViewport,
  setKeyboardInset,
  viewportEnvironment,
} = require('../../../shared/keyboard-avoidance-browser.cjs');

const command = (page, text) => page.evaluate((value) => {
  const xterm = Array.from(document.querySelectorAll('.xterm')).find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const terminal = xterm?.parentElement?.xtermInstance;
  if (!terminal) throw new Error('xterm not attached');
  terminal.input(value + '\n', true);
}, text);

/** Toggle the `+` context disclosure without moving focus off the composer. */
async function toggleContextDisclosure(page, expect, close) {
  const disclosure = page.getByTestId('capsule-context-disclosure');
  await page.getByTestId('capsule-capability-more').evaluate((element) => {
    element.click();
  });
  await expect(disclosure).toHaveCount(close ? 0 : 1, { timeout: 15_000 });
}

test('SC-05: keyboard avoidance and the expanded panel share one reserve', async ({ page }) => {
  test.setTimeout(300_000);
  const { runtime, sha } = verifiedRuntime('SC-05');
  const requests = recordResizeRequests(page);
  await installVisualViewportFixture(page);
  const name = await openSession(page, expect, runtime, 'case-3523-sc05');
  await expect.poll(async () => (await terminalGeometry(page))?.rows ?? 0, {
    timeout: 30_000,
  }).toBeGreaterThan(0);
  // Attach itself may resize legitimately; count only the scenario below.
  await page.waitForTimeout(600);
  requests.length = 0;
  const paneBefore = paneSize(runtime, name);
  const before = await terminalGeometry(page);

  // Normal shell: the upper panel adds scroll clearance, not rows.
  await setKeyboardInset(page, 300);
  await focusCapsuleComposer(page);
  await expect.poll(async () => (await avoidanceState(page))?.scrollable, {
    timeout: 15_000,
  }).toBe(true);
  const keyboardOnly = await terminalGeometry(page);
  expect(keyboardOnly?.rows).toBe(before?.rows);
  expect(keyboardOnly?.occlusion).toBe(before?.occlusion);
  expect(requests.length, 'keyboard-only open sends no PTY resize').toBe(0);

  await toggleContextDisclosure(page, expect, false);
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance ?? 0, {
    timeout: 15_000,
  }).toBeGreaterThan(0);
  const panelOpen = await terminalGeometry(page);
  expect(panelOpen?.occlusion, 'the keyboard does not become composer/panel height')
    .toBe(before?.occlusion);
  expect(panelOpen?.rows, 'normal-buffer panel keeps rows').toBe(before?.rows);
  expect(paneSize(runtime, name), 'normal-buffer panel keeps the pane').toBe(paneBefore);
  expect((await avoidanceState(page))?.scrollable, 'the outer range survives the panel')
    .toBe(true);
  expect((await viewportEnvironment(page))?.keyboard).toBe('open');
  expect(requests.length, 'normal-buffer panel sends no PTY resize').toBe(0);

  await toggleContextDisclosure(page, expect, true);
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance, {
    timeout: 15_000,
  }).toBe(0);
  expect((await terminalGeometry(page))?.rows).toBe(before?.rows);
  expect(paneSize(runtime, name)).toBe(paneBefore);
  expect(requests.length).toBe(0);

  // Alternate-screen + mouse-reporting TUI: the panel policy owns any real row
  // reserve. A simultaneous keyboard must not add a second one. The alternate
  // screen plus mouse tracking is a real terminal mode transition.
  await command(page, "printf '\\033[?1049h\\033[?1000h'; sleep 20");
  await expect.poll(async () => (await terminalGeometry(page))?.bufferType, {
    timeout: 20_000,
  }).toBe('alternate');
  await expect.poll(async () => (await terminalGeometry(page))?.mouseTrackingMode !== 'none', {
    timeout: 10_000,
  }).toBe(true);
  const tuiKeyboard = await terminalGeometry(page);
  await toggleContextDisclosure(page, expect, false);
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance ?? 0, {
    timeout: 15_000,
  }).toBeGreaterThan(0);
  const tuiPanel = await terminalGeometry(page);
  expect(tuiPanel?.occlusion).toBe(tuiKeyboard?.occlusion);
  const fallback = await page.evaluate(() => {
    const host = document.querySelector('[data-terminal-capsule-host]');
    return host?.getAttribute('data-terminal-clearance-fallback') === 'compact';
  });
  if (fallback) {
    expect(tuiPanel?.rows, 'compact fallback reserves no rows').toBe(tuiKeyboard?.rows);
  } else {
    expect(tuiPanel?.rows ?? Infinity).toBeLessThanOrEqual(tuiKeyboard?.rows ?? 0);
  }
  // Toggling the keyboard while the TUI panel is open changes neither the panel
  // reserve nor the terminal rows a second time.
  const rowsWithPanel = tuiPanel?.rows;
  await blurActive(page);
  await expect.poll(async () => (await viewportEnvironment(page))?.keyboard, {
    timeout: 10_000,
  }).toBe('closed');
  expect((await terminalGeometry(page))?.rows, 'keyboard close does not re-reserve')
    .toBe(rowsWithPanel);
  await focusCapsuleComposer(page);
  await expect.poll(async () => (await viewportEnvironment(page))?.keyboard, {
    timeout: 10_000,
  }).toBe('open');
  expect((await terminalGeometry(page))?.rows, 'keyboard reopen does not re-reserve')
    .toBe(rowsWithPanel);

  await toggleContextDisclosure(page, expect, true);
  await expect.poll(async () => (await terminalGeometry(page))?.panelClearance, {
    timeout: 15_000,
  }).toBe(0);
  expect((await terminalGeometry(page))?.rows, 'closing the panel restores TUI rows')
    .toBe(tuiKeyboard?.rows);

  // Leave the TUI and return the shell to the real bottom.
  await command(page, "printf '\\033[?1000l\\033[?1049l'");
  await expect.poll(async () => (await terminalGeometry(page))?.bufferType, {
    timeout: 40_000,
  }).toBe('normal');
  await resetVisualViewport(page);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': with a 300px keyboard-like inset and Capsule focus at ' +
      '390x844 the normal-buffer + context disclosure published panelClearance without changing ' +
      'the composer occlusion (' + before?.occlusion + '), xterm rows (' + before?.rows + ') or ' +
      'the pane ' + paneBefore + ', and sent zero agent.terminal.resize frames; in a real ' +      'alternate-screen + mouse-reporting TUI the panel policy ' +
      (fallback ? 'fell back to compact (no rows)' : 'reserved rows through the authorized path') +
      ' with occlusion unchanged, and closing/reopening the keyboard left the panel row result ' +
      '(' + rowsWithPanel + ') unchanged; closing the panel restored TUI rows ' + tuiKeyboard?.rows +
      '. No double reserve and no second resize.',
  });
});
