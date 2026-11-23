'use strict';
// #4222 SC-02 (dynamic geometry): a per-scrollport measurement is re-derived
// from that element's own visible rect when the viewport, the floating Capsule
// or a sibling footer changes; it is not a number copied from the shell.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const keyboard = require('../../../shared/keyboard-avoidance-browser.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

const VARIABLES = '[data-testid="env-variable-list-scroll"]';
const WARNINGS = '[data-testid="env-var-warnings"]';

test('SC-02 split scrollports recompute when the viewport and Capsule change', async ({ page }) => {
  test.setTimeout(160_000);
  const { sha } = verifiedRuntime('SC-02');

  await page.setViewportSize({ width: 390, height: 844 });
  await helper.openWorkspace(page, 'env', '?env=warnings');
  await page.getByTestId('env-profile-row-server::noisy.env').click();
  await page.getByTestId('env-variable-list-scroll').waitFor({ timeout: 30_000 });

  const atRest = await helper.measureNamedScrollports(page, [VARIABLES, WARNINGS]);
  for (const { selector, state } of atRest) {
    helper.expectEndpoint(state, `Env rest ${selector}`);
  }

  // A shorter visible region: both owners are re-measured independently, and
  // the footer does not inherit the list's inset or vice versa.
  for (const height of [700, 560]) {
    await page.setViewportSize({ width: 390, height });
    await page.waitForTimeout(150);
    const resized = await helper.measureNamedScrollports(page, [VARIABLES, WARNINGS]);
    for (const { selector, state } of resized) {
      helper.expectEndpoint(state, `Env resized ${height} ${selector}`);
    }
    expect(resized[0].state.scroller.bottom).toBeLessThan(resized[1].state.scroller.bottom);
  }

  // A deterministic safe-area input still counts once: the App environment
  // publishes it, and each owner derives its extent from its own rect.
  await page.evaluate(() => {
    const element = document.querySelector('[data-app-viewport-environment]');
    if (element instanceof HTMLElement) {
      element.style.setProperty('--nession-test-safe-area-bottom', '21px');
    }
    window.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => (await keyboard.viewportEnvironment(page))?.safeAreaBottom).toBe(21);
  const safeArea = await helper.measureNamedScrollports(page, [VARIABLES, WARNINGS]);
  for (const { selector, state } of safeArea) {
    helper.expectEndpoint(state, `Env safe-area ${selector}`);
  }
  const padding = await page.evaluate((selectors) => selectors.map((selector) => {
    const element = document.querySelector(selector);
    return element instanceof HTMLElement ? getComputedStyle(element).paddingBottom : null;
  }), [VARIABLES, WARNINGS]);
  for (const value of padding) {
    expect(value, 'the measured inset is a real px value, counted once').toMatch(/^\d+(?:\.\d+)?px$/);
  }

  // Switching the capability away and back remounts the owners; the relation
  // is measured on the new elements, not on stale nodes.
  await page.getByTestId('workspace-tool-files').click();
  await page.getByTestId('workspace-tool-env').click();
  await page.getByTestId('env-profile-row-server::noisy.env').click();
  await page.getByTestId('env-variable-list-scroll').waitFor({ timeout: 30_000 });
  const remounted = await helper.measureNamedScrollports(page, [VARIABLES, WARNINGS]);
  for (const { selector, state } of remounted) {
    helper.expectEndpoint(state, `Env remounted ${selector}`);
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      `exact SHA ${sha}: with the Environment variables list and warnings footer `
      + 'visible, shortening the viewport (844 -> 700 -> 560) and changing the '
      + 'App safe-area input re-derived each owner\'s endpoint from its own rect. '
      + 'Both owners still ended above the live Capsule with no blank tail, the '
      + 'two bottoms stayed distinct, and a capability switch remounted and '
      + 're-measured fresh elements.',
  });
});
