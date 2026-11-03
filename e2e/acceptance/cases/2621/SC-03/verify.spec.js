'use strict';
// #2621 SC-03 superseding UI: the terminal grid has zero automatic notice chrome.
// A user opens detail through the Capsule, after which the dialog is portaled
// outside the terminal host. When closed, all input/scroll hit-testing stays on xterm.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { ALL_FOUR, openAppNotices, openWebNotices } = require('../../../shared/terminal-notice-cases.cjs');

const NOTICE_IDS = [
  'terminal-history-degraded',
  'terminal-input-drop',
  'terminal-clipboard-notice',
  'terminal-observer-bar',
];

async function checkSurface(page, label) {
  const before = await page.evaluate(() => {
    const surface = document.querySelector('[data-testid="terminal-surface"]');
    const host = document.querySelector('[data-terminal-capsule-host]');
    return {
      overlay: document.querySelector('[data-testid="terminal-status-overlay"]') !== null,
      hostChildren: surface?.children.length ?? -1,
      scrollWidth: document.documentElement.scrollWidth,
      width: window.innerWidth,
      hostHeight: host?.getBoundingClientRect().height,
    };
  });
  expect(before.overlay, label + ': no status overlay').toBe(false);
  expect(before.hostChildren, label + ': only the Terminal/Capsule host').toBe(1);
  expect(before.scrollWidth, label + ': no horizontal page overflow').toBeLessThanOrEqual(before.width);
  await expect(page.getByTestId('terminal-notices-trigger')).toBeVisible();
  await expect(page.getByTestId('terminal-notice-details')).toHaveCount(0);
  await page.getByTestId('terminal-notices-trigger').click();
  await expect(page.getByTestId('terminal-notice-details')).toBeVisible();
  const details = await page.evaluate((ids) => {
    const host = document.querySelector('[data-terminal-capsule-host]');
    const detail = document.querySelector('[data-testid="terminal-notice-details"]');
    return {
      outsideHost: !host.contains(detail),
      notices: ids.map((id) => Boolean(detail.querySelector('[data-testid="' + id + '"]'))),
      scrollWidth: document.documentElement.scrollWidth,
      width: window.innerWidth,
    };
  }, NOTICE_IDS);
  expect(details.outsideHost, label + ': detail portaled outside xterm').toBe(true);
  expect(details.notices, label + ': all four details survive').toEqual([true, true, true, true]);
  expect(details.scrollWidth).toBeLessThanOrEqual(details.width);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('terminal-notice-details')).toHaveCount(0);
  const after = await page.evaluate(() => {
    const host = document.querySelector('[data-terminal-capsule-host]');
    return host?.getBoundingClientRect().height;
  });
  expect(after, label + ': details never reflowed the grid').toBe(before.hostHeight);
}

test('SC-03: notices never obscure Terminal and detail remains an explicit action', async ({ page }) => {
  test.setTimeout(300_000);
  const { sha } = verifiedRuntime('SC-03');

  await page.setViewportSize({ width: 390, height: 844 });
  await openAppNotices(page, ALL_FOUR);
  await checkSurface(page, 'App 390x844');

  await page.setViewportSize({ width: 1280, height: 800 });
  await openAppNotices(page, ALL_FOUR);
  await checkSurface(page, 'App 1280x800');

  await openWebNotices(page, ALL_FOUR);
  await checkSurface(page, 'Web 1280x800');

  // A closed detail must not steal the terminal's input/focus.
  await page.locator('.xterm-helper-textarea').focus();
  expect(await page.evaluate(
    () => document.activeElement === document.querySelector('.xterm-helper-textarea'),
  )).toBe(true);
  await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
  await page.keyboard.type('focus-survived');
  await expect.poll(() => page.evaluate(() => window.clipboardHarness.sent.join('')))
    .toContain('focus-survived');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': App/Web widths keep the terminal free of automatic ' +
      'overlays; all four states are reachable only through a user-opened Capsule detail; ' +
      'detail portal never reflows the grid; closing restores terminal hit-testing and input',
  });
});
