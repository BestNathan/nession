'use strict';
// #2621 SC-03 (superseded presentation, #2658): the Terminal grid has zero
// automatic notice chrome. The user opens details through the Capsule; the
// dialog portals outside the terminal host. When closed, input and
// hit-testing belong to xterm again, and the grid never moved.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  ALL_FOUR, openAppNotices, openNoticesDisclosure, openWebNotices,
} = require('../../../shared/terminal-notice-cases.cjs');

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
  await expect(page.getByTestId('terminal-notice-details')).toHaveCount(0);
  await expect(page.getByTestId('terminal-notices-trigger')).toBeVisible();

  await openNoticesDisclosure(page);
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
  expect(details.scrollWidth, label + ': no horizontal overflow while open')
    .toBeLessThanOrEqual(details.width);

  // Closing the disclosure must return the grid to the exact same box.
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

  // `copy-required` keeps the clipboard detail alive for 30 s, so all four
  // remain available while the dialog is opened and measured.
  await openWebNotices(page, '?history=degraded&drop=epoch&role=observer&clipboard=copy-required');
  await checkSurface(page, 'Web 1280x800');

  // Escape returns focus to the action that opened the disclosure.
  await openNoticesDisclosure(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('terminal-notice-details')).toHaveCount(0);
  expect(await page.evaluate(
    () => document.activeElement?.getAttribute('data-testid'),
  )).toBe('terminal-notices-trigger');

  // With no disclosure open, the terminal keeps focus and input even while
  // the clipboard notice expires in the background.
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
    description: 'exact SHA ' + sha + ': App 390x844 and 1280x800 and Web 1280x800 kept the ' +
      'surface root free of automatic overlays, announced availability only through the Capsule ' +
      'action, mounted all four details only after the user gesture inside a portal outside the ' +
      'capsule host, fit without horizontal overflow, and restored the exact host height on ' +
      'close; Escape returned focus to the trigger and the terminal kept focus and input across ' +
      'a background clipboard expiry',
  });
});
