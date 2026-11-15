'use strict';
// #3523 SC-04: composer single→multiline→single changes the composer-only
// clearance / eventual rows exactly as the existing fit dictates; a
// keyboard-only visible-viewport change (open/adjust/close, repeated equivalent
// snapshots) never becomes a composer fit input and never oscillates rows.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  avoidanceState,
  blurActive,
  focusCapsuleComposer,
  installVisualViewportFixture,
  resetVisualViewport,
  setKeyboardInset,
  terminalFacts,
  viewportEnvironment,
} = require('../../../shared/keyboard-avoidance-browser.cjs');

const composerOcclusion = (page) => page.evaluate(() => {
  const host = document.querySelector('[data-terminal-capsule-host]');
  if (!(host instanceof HTMLElement)) return null;
  return getComputedStyle(host)
    .getPropertyValue('--nession-local-terminal-capsule-occlusion')
    .trim();
});

test('SC-04: composer fit changes only for real composer height, never for keyboard movement', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 390, height: 844 });
  await installVisualViewportFixture(page);
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-layer-root').waitFor({ timeout: 30_000 });
  await page.locator('.xterm').waitFor({ timeout: 30_000 });
  await expect.poll(async () => (await terminalFacts(page))?.rows ?? 0, {
    timeout: 20_000,
  }).toBeGreaterThan(0);
  const before = await terminalFacts(page);
  const occlusionBefore = await composerOcclusion(page);

  // Keyboard-only cycles: open/adjust/close do not touch the composer fit
  // input, xterm rows, or the resize count.
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await setKeyboardInset(page, 300);
    await focusCapsuleComposer(page);
    await expect.poll(async () => (await avoidanceState(page))?.scrollable, {
      timeout: 10_000,
    }).toBe(true);
    await blurActive(page);
    await expect.poll(async () => (await avoidanceState(page))?.scrollable, {
      timeout: 10_000,
    }).toBe(false);
    expect(await composerOcclusion(page)).toBe(occlusionBefore);
    expect((await terminalFacts(page))?.rows).toBe(before?.rows);
    expect((await terminalFacts(page))?.resizes).toBe(before?.resizes);
  }

  // Repeated equivalent environment snapshots must not oscillate the range.
  await focusCapsuleComposer(page);
  await expect.poll(async () => (await avoidanceState(page))?.scrollable, {
    timeout: 10_000,
  }).toBe(true);
  const settled = await avoidanceState(page);
  for (let repeat = 0; repeat < 3; repeat += 1) {
    await setKeyboardInset(page, 300);
    await page.waitForTimeout(120);
  }
  const repeated = await avoidanceState(page);
  expect(repeated?.extent).toBe(settled?.extent);
  expect(repeated?.scrollTop).toBe(settled?.scrollTop);
  expect((await terminalFacts(page))?.rows).toBe(before?.rows);
  expect((await terminalFacts(page))?.resizes).toBe(before?.resizes);

  // Real composer growth remains the surface's own fit input: rows may change
  // only when the integer row result changes, and clearing restores the fit.
  const field = page.getByTestId('capsule-ghost-input');
  await field.fill('line one\nline two\nline three\nline four');
  await expect.poll(async () => (await composerOcclusion(page)) !== occlusionBefore, {
    timeout: 10_000,
  }).toBe(true);
  const grown = await terminalFacts(page);
  expect(grown?.rows ?? 0).toBeLessThanOrEqual(before?.rows ?? 0);
  expect((await avoidanceState(page))?.scrollable, 'the range survives a taller composer')
    .toBe(true);

  await field.fill('');
  await expect.poll(async () => (await composerOcclusion(page)), {
    timeout: 10_000,
  }).toBe(occlusionBefore);
  await expect.poll(async () => (await terminalFacts(page))?.rows, {
    timeout: 10_000,
  }).toBe(before?.rows);
  expect((await viewportEnvironment(page))?.keyboard).toBe('open');
  await resetVisualViewport(page);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': three keyboard open/close cycles left the ' +
      'composer-only occlusion ' + occlusionBefore + ', xterm rows (' + before?.rows + ') and ' +
      'the resize count (' + before?.resizes + ') unchanged; three repeated equivalent snapshots ' +
      'preserved the same extent and scroll position; a real 4-line composer grew the measured ' +
      'composer occlusion, changed rows only downward per the existing fit (observed ' +
      grown?.rows + '), and clearing restored occlusion ' + occlusionBefore + ' and rows ' +
      before?.rows + '. Chromium app-owned fit proof.',
  });
});
