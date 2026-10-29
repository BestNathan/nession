'use strict';
// #2621 SC-01: every Terminal status type is a zero-content overlay — the
// xterm viewport, the capsule host and the grid (rows/cols) are identical with
// the notice present, absent again, and after a real expiry. Measured in a real
// browser on both experiences; jsdom cannot measure layout.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  ALL_FOUR, openAppNotices, openWebNotices, readGeometry, stablePart,
} = require('../../../shared/terminal-notice-cases.cjs');

const ROUTES = [
  ['input-drop', '?drop=epoch'],
  ['history-degraded', '?history=degraded'],
  ['observer', '?role=observer'],
  ['clipboard', '?clipboard=write-denied'],
  ['all four together', ALL_FOUR],
];

test('SC-01: status notices leave the Terminal grid unchanged on App and Web', async ({ page }) => {
  test.setTimeout(300_000);
  const { sha } = verifiedRuntime('SC-01');
  const measurements = [];

  // The App experience at its canonical 390x844.
  await page.setViewportSize({ width: 390, height: 844 });
  await openAppNotices(page);
  const appBaseline = await readGeometry(page, 'fixture-terminal');
  expect(appBaseline.rows, 'the App fixture must render a real grid').toBeGreaterThan(0);
  expect(appBaseline.overlay, 'the healthy state has no status placeholder').toBeNull();
  for (const [name, params] of ROUTES) {
    await openAppNotices(page, params);
    const geometry = await readGeometry(page, 'fixture-terminal');
    expect(geometry.overlay, name + ': the notice must be present').not.toBeNull();
    expect(stablePart(geometry), name + ': App grid must not move').toEqual(stablePart(appBaseline));
    measurements.push({ experience: 'app', notice: name, rows: geometry.rows, cols: geometry.cols });
  }
  // Disappearance: the healthy route again, same grid.
  await openAppNotices(page);
  expect(stablePart(await readGeometry(page, 'fixture-terminal')))
    .toEqual(stablePart(appBaseline));

  // The Web experience at 1280x800.
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWebNotices(page);
  const webBaseline = await readGeometry(page, 'fixture-clipboard-host');
  expect(webBaseline.rows, 'the Web fixture must render a real grid').toBeGreaterThan(0);
  expect(webBaseline.overlay).toBeNull();
  for (const [name, params] of ROUTES) {
    await openWebNotices(page, params);
    const geometry = await readGeometry(page, 'fixture-clipboard-host');
    expect(geometry.overlay, name + ': the notice must be present').not.toBeNull();
    expect(stablePart(geometry), name + ': Web grid must not move').toEqual(stablePart(webBaseline));
    measurements.push({ experience: 'web', notice: name, rows: geometry.rows, cols: geometry.cols });
  }

  // A notice that disappears on its own: the clipboard notice expires (5 s)
  // and the grid must return to the exact baseline, not merely to a safe value.
  await openWebNotices(page, '?clipboard=write-denied');
  const withNotice = await readGeometry(page, 'fixture-clipboard-host');
  expect(withNotice.overlay).not.toBeNull();
  expect(stablePart(withNotice)).toEqual(stablePart(webBaseline));
  await expect(page.getByTestId('terminal-status-overlay')).toHaveCount(0, { timeout: 15_000 });
  expect(stablePart(await readGeometry(page, 'fixture-clipboard-host')))
    .toEqual(stablePart(webBaseline));

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': App 390x844 baseline ' + appBaseline.cols + 'x' +
      appBaseline.rows + ' rows with host ' + appBaseline.host.height + 'px; Web 1280x800 baseline ' +
      webBaseline.cols + 'x' + webBaseline.rows + ' rows with host ' + webBaseline.host.height +
      'px; input-drop, history-degraded, observer, clipboard and all-four-together each left the ' +
      'rows, cols, host, viewport and surface boxes identical; the Web clipboard notice expired ' +
      'and the grid returned to the same baseline',
  });
});
