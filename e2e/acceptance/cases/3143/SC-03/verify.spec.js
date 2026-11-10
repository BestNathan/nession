'use strict';
// #3143 SC-03: horizontally scrollable peer tabs above one vertically
// scrollable editor at 390/375; the host owns one Back, tab switches never
// push depth, and the strip remains available while content scrolls.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  TABS,
  openAppSandbox,
  selectTab,
} = require('../../../shared/sandbox-tabs-browser.cjs');

test.setTimeout(180_000);

test('SC-03: horizontal peer tabs, one host Back and no depth per switch', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-03');
  await page.setViewportSize({ width: 390, height: 844 });
  await openAppSandbox(page);
  const historyLength = await page.evaluate(() => window.history.length);

  await expect(page.getByTestId('app-page-back')).toHaveCount(1);
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to terminal');
  await expect(page.getByTestId('sandbox-tabs')).toHaveAttribute(
    'data-orientation',
    'horizontal',
  );
  const overview = await page.getByTestId('sandbox-tab-overview').boundingBox();
  expect(overview).not.toBeNull();
  expect(overview.height).toBeGreaterThanOrEqual(44);

  const content = {
    overview: 'sandbox-policy-preview',
    filesystem: 'sandbox-fs-read',
    network: 'sandbox-network-mode',
    process: 'sandbox-namespace-pid',
    resource: 'sandbox-resource-add',
    syscall: 'sandbox-syscall-profile',
  };
  for (const tab of TABS) {
    await selectTab(page, tab);
    await expect(page.getByTestId(content[tab])).toBeVisible();
    await expect(page.getByTestId('app-page-back')).toHaveCount(1);
    await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to terminal');
  }

  await selectTab(page, 'overview');
  await page.getByTestId('sandbox-tab-overview').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('sandbox-tab-filesystem')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('sandbox-tab-filesystem')).toBeFocused();
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);

  // The only pushed depth is the explicit confirmation; its Back restores the
  // selected tab and leaves the draft/preflight intact.
  await selectTab(page, 'overview');
  await page.getByTestId('sandbox-preflight').click();
  await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
  await page.getByTestId('sandbox-enter').click();
  await expect(page.getByTestId('sandbox-confirm')).toBeVisible();
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to Sandbox');
  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('sandbox-composer')).toBeVisible();
  await expect(page.getByTestId('sandbox-tab-overview')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 390 switched all six 44px peer tabs directly with one host ' +
      'Back, no history depth, arrow navigation, and confirmation Back restoring the tab',
  });
});

test('SC-03: the strip stays above the one vertical scroller at 390/375', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-03');
  await page.setViewportSize({ width: 390, height: 844 });
  await openAppSandbox(page);
  await selectTab(page, 'resource');
  for (let index = 0; index < 8; index += 1) {
    await page.getByTestId('sandbox-resource-add').click();
  }
  await expect(page.getByTestId('sandbox-resource-row-7')).toBeVisible();

  const scroller = page.getByTestId('sandbox-app-scroll');
  await scroller.evaluate((element) => {
    element.scrollTop = 400;
  });
  const scrollerBox = await scroller.boundingBox();
  const tabsBox = await page.getByTestId('sandbox-tabs').boundingBox();
  expect(scrollerBox).not.toBeNull();
  expect(tabsBox).not.toBeNull();
  expect(tabsBox.y).toBeGreaterThanOrEqual(scrollerBox.y - 1);
  expect(tabsBox.y - scrollerBox.y).toBeLessThan(16);

  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);
  await expect(page.getByTestId('sandbox-app-scroll')).toBeVisible();
  await expect(page.getByTestId('app-page-back')).toHaveCount(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 390/375 kept the peer strip above the single vertical ' +
      'scroller with no horizontal overflow and exactly one host Back',
  });
});
