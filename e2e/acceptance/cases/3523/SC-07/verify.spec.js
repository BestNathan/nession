'use strict';
// #3523 SC-07: in an isolated real Terminal runtime, a keyboard-only
// viewport/focus/avoidance sequence sends **zero** `agent.terminal.resize`
// frames and leaves the authoritative tmux pane unchanged; actual composer or
// eligible TUI panel row changes still use the existing authorized path.
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

test('SC-07: keyboard-only movement sends zero PTY resizes and keeps the pane size', async ({ page }) => {
  test.setTimeout(300_000);
  const { runtime, sha } = verifiedRuntime('SC-07');
  await page.setViewportSize({ width: 1280, height: 800 });
  await installVisualViewportFixture(page);
  const requests = recordResizeRequests(page);
  const name = await openSession(page, expect, runtime, 'case-3523-sc07');
  await expect.poll(async () => (await terminalGeometry(page))?.rows ?? 0, {
    timeout: 30_000,
  }).toBeGreaterThan(0);
  await resetVisualViewport(page);
  await page.waitForTimeout(800);
  // Setup (attach, breakpoint handoff) may legitimately resize; count only the
  // keyboard-only sequence below.
  requests.length = 0;
  const paneBefore = paneSize(runtime, name);
  const before = await terminalGeometry(page);
  const colsBefore = await page.evaluate(
    () => document.querySelector('.xterm')?.parentElement?.xtermInstance?.cols ?? null,
  );
  await page.locator('.xterm').evaluate((element) => {
    element.setAttribute('data-3523-sc07-instance', 'original');
  });
  const xtermScrollBefore = await page.evaluate(
    () => document.querySelector('.xterm-viewport')?.scrollTop ?? null,
  );

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await setKeyboardInset(page, 300);
    await focusCapsuleComposer(page);
    await expect.poll(async () => (await viewportEnvironment(page))?.keyboard, {
      timeout: 15_000,
    }).toBe('open');
    await expect.poll(async () => (await avoidanceState(page))?.scrollable, {
      timeout: 15_000,
    }).toBe(true);
    expect((await avoidanceState(page))?.scrollTop ?? 0).toBeGreaterThan(0);
    expect((await terminalGeometry(page))?.rows, 'keyboard open keeps rows').toBe(before?.rows);

    await setKeyboardInset(page, 360);
    await expect.poll(async () => (await viewportEnvironment(page))?.visibleHeight, {
      timeout: 10_000,
    }).toBe(484);
    expect((await terminalGeometry(page))?.rows, 'keyboard adjust keeps rows').toBe(before?.rows);

    await blurActive(page);
    await expect.poll(async () => (await viewportEnvironment(page))?.keyboard, {
      timeout: 10_000,
    }).toBe('closed');
    expect((await terminalGeometry(page))?.rows, 'keyboard close keeps rows').toBe(before?.rows);
  }
  await resetVisualViewport(page);

  expect(requests.length, 'keyboard-only sequence sent no agent.terminal.resize frames').toBe(0);
  expect(paneSize(runtime, name), 'authoritative pane size unchanged').toBe(paneBefore);
  const after = await terminalGeometry(page);
  expect(after?.rows).toBe(before?.rows);
  expect(await page.evaluate(
    () => document.querySelector('.xterm')?.parentElement?.xtermInstance?.cols ?? null,
  )).toBe(colsBefore);
  expect(await page.locator('.xterm[data-3523-sc07-instance="original"]').count(),
    'the same Terminal instance stayed mounted').toBe(1);
  expect(await page.evaluate(
    () => document.querySelector('.xterm-viewport')?.scrollTop ?? null,
  )).toBe(xtermScrollBefore);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': three keyboard open(300px)/adjust(360px)/close cycles ' +
      'at 390x844 on a real Relay session produced no agent.terminal.resize frames, kept xterm ' +
      'rows (' + before?.rows + ') and columns (' + colsBefore + '), left the pane ' + paneBefore +
      ' unchanged, preserved the same mounted xterm instance and did not move the xterm viewport ' +
      'scroll position while a real bounded outer avoidance range existed.',
  });
});
