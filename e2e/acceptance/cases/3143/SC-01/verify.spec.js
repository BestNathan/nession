'use strict';
// #3143 SC-01: six persistent peer tabs with direct cross-policy switching;
// no Home -> module -> Back drill-down and no five inline editors.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  TABS,
  openWebSandbox,
  selectTab,
} = require('../../../shared/sandbox-tabs-browser.cjs');

test.setTimeout(180_000);

test('SC-01: six peer tabs switch directly without history depth', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 1180, height: 900 });
  await openWebSandbox(page);
  const historyLength = await page.evaluate(() => window.history.length);

  await expect(page.getByTestId('sandbox-tabs')).toBeVisible();
  for (const tab of TABS) {
    await expect(page.getByTestId(`sandbox-tab-${tab}`)).toBeVisible();
  }
  await expect(page.getByTestId('sandbox-home')).toHaveCount(0);
  await expect(page.getByTestId('sandbox-policy-preview')).toBeVisible();
  await expect(page.getByTestId('sandbox-resource-add')).toHaveCount(0);

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
    await expect(page.getByTestId(`sandbox-tabpanel-${tab}`)).toBeVisible();
    await expect(page.getByTestId(content[tab])).toBeVisible();
  }

  // The Overview summary is a second direct switch to the same peer tabs.
  await selectTab(page, 'overview');
  await page.getByTestId('sandbox-summary-network').click();
  await expect(page.getByTestId('sandbox-tab-network')).toHaveAttribute('aria-selected', 'true');

  // Keyboard arrows/Home/End move within the peer list and keep focus.
  await selectTab(page, 'overview');
  await page.getByTestId('sandbox-tab-overview').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('sandbox-tab-filesystem')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('sandbox-tab-filesystem')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByTestId('sandbox-tab-syscall')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(page.getByTestId('sandbox-tab-overview')).toHaveAttribute('aria-selected', 'true');

  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web 1180 switched all six peer tabs and the Overview summary ' +
      'directly, with arrows/Home/End, no Home page, no five inline editors and unchanged history',
  });
});
