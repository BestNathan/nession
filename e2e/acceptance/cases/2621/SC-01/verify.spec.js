'use strict';
// #2621 SC-01 (superseded presentation, #2658): every Terminal status type is
// zero-content ambient chrome — the xterm viewport, the capsule host and the
// grid (rows/cols) are identical when availability appears, when the opt-in
// disclosure opens, and after a real expiry. Measured in a real browser on both
// experiences; jsdom cannot measure layout.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  ALL_FOUR, openAppNotices, openNoticesDisclosure, openWebNotices,
  readGeometry, stablePart,
} = require('../../../shared/terminal-notice-cases.cjs');

const ROUTES = [
  ['input-drop', '?drop=epoch', ['input-drop']],
  ['history-degraded', '?history=degraded', ['history-degraded']],
  ['observer', '?role=observer', ['observer']],
  ['clipboard', '?clipboard=copy-required', ['clipboard']],
  ['all four together', ALL_FOUR, ['history-degraded', 'input-drop', 'clipboard', 'observer']],
];

const DETAIL_IDS = [
  'terminal-history-degraded',
  'terminal-input-drop',
  'terminal-clipboard-notice',
  'terminal-observer-bar',
];

async function expectNoAutomaticChrome(page, viewportTestId, tokens) {
  const geometry = await readGeometry(page, viewportTestId);
  expect(geometry.overlay, 'no automatic status overlay').toBeNull();
  for (const id of DETAIL_IDS) {
    expect(await page.getByTestId(id).count(), id + ' must not be mounted automatically').toBe(0);
  }
  await expect(page.getByTestId('terminal-notices-trigger')).toBeVisible();
  for (const token of tokens) {
    expect((geometry.notices ?? '').split(/\s+/), token + ' is announced').toContain(token);
  }
  return geometry;
}

test('SC-01: status availability leaves the Terminal grid unchanged on App and Web', async ({ page }) => {
  test.setTimeout(300_000);
  const { sha } = verifiedRuntime('SC-01');
  const measurements = [];

  // The App experience at its canonical 390x844.
  await page.setViewportSize({ width: 390, height: 844 });
  await openAppNotices(page);
  const appBaseline = await readGeometry(page, 'fixture-terminal');
  expect(appBaseline.rows, 'the App fixture must render a real grid').toBeGreaterThan(0);
  expect(appBaseline.overlay, 'the healthy state has no status placeholder').toBeNull();
  expect(appBaseline.notices, 'the healthy state announces no notice').toBeNull();
  await expect(page.getByTestId('terminal-notices-trigger')).toHaveCount(0);

  for (const [name, params, tokens] of ROUTES) {
    await openAppNotices(page, params);
    const geometry = await expectNoAutomaticChrome(page, 'fixture-terminal', tokens);
    expect(stablePart(geometry), name + ': App grid must not move').toEqual(stablePart(appBaseline));
    measurements.push({ experience: 'app', notice: name, rows: geometry.rows, cols: geometry.cols });
  }
  // Opening the disclosure is an explicit overlay and still no grid work.
  await openAppNotices(page, ALL_FOUR);
  await openNoticesDisclosure(page);
  expect(stablePart(await readGeometry(page, 'fixture-terminal')))
    .toEqual(stablePart(appBaseline));

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
  expect(webBaseline.notices).toBeNull();
  await expect(page.getByTestId('terminal-notices-trigger')).toHaveCount(0);

  for (const [name, params, tokens] of ROUTES) {
    await openWebNotices(page, params);
    const geometry = await expectNoAutomaticChrome(page, 'fixture-clipboard-host', tokens);
    expect(stablePart(geometry), name + ': Web grid must not move').toEqual(stablePart(webBaseline));
    measurements.push({ experience: 'web', notice: name, rows: geometry.rows, cols: geometry.cols });
  }
  await openWebNotices(page, ALL_FOUR);
  await openNoticesDisclosure(page);
  expect(stablePart(await readGeometry(page, 'fixture-clipboard-host')))
    .toEqual(stablePart(webBaseline));

  // A notice that disappears on its own: the clipboard notice expires (5 s)
  // and the trigger disappears with it, leaving the exact baseline.
  await openWebNotices(page, '?clipboard=write-denied');
  const withNotice = await readGeometry(page, 'fixture-clipboard-host');
  expect(withNotice.overlay).toBeNull();
  await expect(page.getByTestId('terminal-notices-trigger')).toBeVisible();
  expect(stablePart(withNotice)).toEqual(stablePart(webBaseline));
  await expect(page.getByTestId('terminal-notices-trigger')).toHaveCount(0, { timeout: 15_000 });
  expect(stablePart(await readGeometry(page, 'fixture-clipboard-host')))
    .toEqual(stablePart(webBaseline));

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': App 390x844 baseline ' + appBaseline.cols + 'x' +
      appBaseline.rows + ' rows with host ' + appBaseline.host.height + 'px; Web 1280x800 baseline ' +
      webBaseline.cols + 'x' + webBaseline.rows + ' rows with host ' + webBaseline.host.height +
      'px; input-drop, history-degraded, observer, clipboard and all-four-together left the rows, ' +
      'cols, host, viewport and surface boxes identical, mounted no notice content, and only ' +
      'announced availability through the Capsule action; opening the opt-in disclosure changed ' +
      'no grid box; the Web clipboard notice expired and the grid returned to the same baseline',
  });
});
