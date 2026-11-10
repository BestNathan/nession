'use strict';
// #3143 SC-02: sticky left strategy navigation beside one wide, independently
// scrollable editor at 1180/1024; no shell/Capsule overlap and no horizontal
// page overflow for long paths or KV rows.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openWebSandbox,
  selectTab,
} = require('../../../shared/sandbox-tabs-browser.cjs');

test.setTimeout(180_000);

test('SC-02: sticky left navigation and one scrolling editor at 1180', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 1180, height: 900 });
  await openWebSandbox(page);
  await selectTab(page, 'resource');
  for (let index = 0; index < 8; index += 1) {
    await page.getByTestId('sandbox-resource-add').click();
  }
  await expect(page.getByTestId('sandbox-resource-row-7')).toBeVisible();

  const content = page.getByTestId('sandbox-tab-content');
  expect(
    await content.evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  const tabsBefore = await page.getByTestId('sandbox-tabs').boundingBox();
  const contentBox = await content.boundingBox();
  expect(tabsBefore).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(tabsBefore.x + tabsBefore.width).toBeLessThanOrEqual(contentBox.x + 1);
  expect(contentBox.x + contentBox.width).toBeLessThanOrEqual(1180);

  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const tabsAfter = await page.getByTestId('sandbox-tabs').boundingBox();
  expect(tabsAfter).not.toBeNull();
  expect(Math.abs(tabsAfter.y - tabsBefore.y)).toBeLessThan(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web 1180 kept the left tab list fixed while only the selected ' +
      'editor scrolled, with no horizontal overflow',
  });
});

test('SC-02: a long path and KV row wrap without pane overflow at 1024', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 1024, height: 768 });
  await openWebSandbox(page);
  await selectTab(page, 'filesystem');
  await page.getByTestId('sandbox-fs-read-add').click();
  await page.getByTestId('sandbox-fs-read-0').fill('/usr/' + 'nested/'.repeat(30) + 'toolchain');
  await expect(page.getByTestId('sandbox-fs-read-0')).toHaveValue(/nested\//);

  await selectTab(page, 'resource');
  await page.getByTestId('sandbox-resource-add').click();
  await page.getByTestId('sandbox-resource-key-0').fill('cpu.max');
  await page.getByTestId('sandbox-resource-value-0').fill('200000 100000');

  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);
  const input = await page.getByTestId('sandbox-resource-key-0').boundingBox();
  expect(input).not.toBeNull();
  expect(input.x + input.width).toBeLessThanOrEqual(1024);
  const tabs = await page.getByTestId('sandbox-tabs').boundingBox();
  const content = await page.getByTestId('sandbox-tab-content').boundingBox();
  expect(tabs).not.toBeNull();
  expect(content).not.toBeNull();
  expect(tabs.x + tabs.width).toBeLessThanOrEqual(content.x + 1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web 1024 kept a very long filesystem path and a KV row inside ' +
      'the pane with no page overflow, and preserved the left-nav/editor split',
  });
});
