'use strict';
// #2658 SC-01: the Terminal shows no automatic status overlay on Web or App,
// and its host/grid size is identical in healthy, degraded, observer,
// input-drop and clipboard states — including while the opt-in disclosure is
// open and after a real expiry.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  ALL_FOUR, openAppNotices, openNoticesDisclosure, openWebNotices,
  readGeometry, stablePart,
} = require('../../../shared/terminal-notice-cases.cjs');

const ROUTES = [
  ['input-drop', '?drop=epoch', 'input-drop'],
  ['history-degraded', '?history=degraded', 'history-degraded'],
  ['observer', '?role=observer', 'observer'],
  ['clipboard', '?clipboard=copy-required', 'clipboard'],
];

const DETAIL_IDS = [
  'terminal-history-degraded',
  'terminal-input-drop',
  'terminal-clipboard-notice',
  'terminal-observer-bar',
];

async function expectOffGrid(page, viewportTestId, token) {
  const geometry = await readGeometry(page, viewportTestId);
  expect(geometry.overlay, 'no automatic status overlay').toBeNull();
  for (const id of DETAIL_IDS) {
    expect(await page.getByTestId(id).count(), id + ' is not mounted automatically').toBe(0);
  }
  await expect(page.getByTestId('terminal-notices-trigger')).toBeVisible();
  expect((geometry.notices ?? '').split(/\s+/)).toContain(token);
  return geometry;
}

test('SC-01: no automatic notice chrome and no grid movement on App or Web', async ({ page }) => {
  test.setTimeout(300_000);
  const { sha } = verifiedRuntime('SC-01');

  // App 390x844.
  await page.setViewportSize({ width: 390, height: 844 });
  await openAppNotices(page);
  const appBaseline = await readGeometry(page, 'fixture-terminal');
  expect(appBaseline.rows).toBeGreaterThan(0);
  await expect(page.getByTestId('terminal-notices-trigger')).toHaveCount(0);
  for (const [name, params, token] of ROUTES) {
    await openAppNotices(page, params);
    const geometry = await expectOffGrid(page, 'fixture-terminal', token);
    expect(stablePart(geometry), name + ': App grid must not move').toEqual(stablePart(appBaseline));
  }
  await openAppNotices(page, ALL_FOUR);
  await openNoticesDisclosure(page);
  expect(stablePart(await readGeometry(page, 'fixture-terminal')))
    .toEqual(stablePart(appBaseline));

  // Web 1280x800 with the real controller.
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWebNotices(page);
  const webBaseline = await readGeometry(page, 'fixture-clipboard-host');
  expect(webBaseline.rows).toBeGreaterThan(0);
  for (const [name, params, token] of ROUTES) {
    await openWebNotices(page, params);
    const geometry = await expectOffGrid(page, 'fixture-clipboard-host', token);
    expect(stablePart(geometry), name + ': Web grid must not move').toEqual(stablePart(webBaseline));
  }
  await openWebNotices(page, ALL_FOUR);
  await openNoticesDisclosure(page);
  expect(stablePart(await readGeometry(page, 'fixture-clipboard-host')))
    .toEqual(stablePart(webBaseline));

  // Expiry removes the action but moves nothing.
  await openWebNotices(page, '?clipboard=write-denied');
  await expect(page.getByTestId('terminal-notices-trigger')).toBeVisible();
  expect(stablePart(await readGeometry(page, 'fixture-clipboard-host')))
    .toEqual(stablePart(webBaseline));
  await expect(page.getByTestId('terminal-notices-trigger')).toHaveCount(0, { timeout: 15_000 });
  expect(stablePart(await readGeometry(page, 'fixture-clipboard-host')))
    .toEqual(stablePart(webBaseline));

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': App 390x844 baseline ' + appBaseline.cols + 'x' +
      appBaseline.rows + ' and Web 1280x800 baseline ' + webBaseline.cols + 'x' +
      webBaseline.rows + ' kept identical rows, cols, host, viewport and surface boxes for ' +
      'input-drop, history-degraded, observer, clipboard and all four together; no overlay or ' +
      'notice content mounted automatically, the Capsule action announced availability, opening ' +
      'the disclosure moved no grid box, and clipboard expiry restored the exact baseline',
  });
});
