'use strict';
// #3141 SC-04: the Resource tab is an empty-first native Key/Value editor fed
// by discovered controller files, accepts raw multi-token text, rejects
// lifecycle keys, invalidates preflight on a real edit, and shows the observed
// inside readback. Web 1180/1024 and App 390/375 keep their geometry.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openWebSandbox,
  openAppSandbox,
  selectTab,
} = require('../../../shared/sandbox-tabs-browser.cjs');

test.setTimeout(180_000);

test('SC-04: discovered files, raw native text and lifecycle rejection', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 1180, height: 900 });
  await openWebSandbox(page);
  await selectTab(page, 'resource');

  for (const key of ['cpu.weight', 'memory.high', 'io.max']) {
    await expect(
      page.locator(`#sandbox-resource-key-options option[value="${key}"]`),
    ).toHaveCount(1);
  }

  await page.getByTestId('sandbox-resource-add').click();
  await page.getByTestId('sandbox-resource-key-0').fill('cpu.weight');
  await page.getByTestId('sandbox-resource-value-0').fill('100');
  await page.getByTestId('sandbox-resource-add').click();
  await page.getByTestId('sandbox-resource-key-1').fill('cpu.max');
  await page.getByTestId('sandbox-resource-value-1').fill('200000 100000');
  await page.getByTestId('sandbox-resource-add').click();
  await page.getByTestId('sandbox-resource-key-2').fill('cgroup.procs');
  await page.getByTestId('sandbox-resource-value-2').fill('4242');

  await selectTab(page, 'overview');
  await page.getByTestId('sandbox-preflight').click();
  await expect(page.getByTestId('sandbox-preflight-errors')).toContainText('lifecycle');
  await expect(page.getByTestId('sandbox-enter')).toBeDisabled();

  await selectTab(page, 'resource');
  await page.getByTestId('sandbox-resource-remove-2').click();
  await selectTab(page, 'overview');
  await page.getByTestId('sandbox-preflight').click();
  await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
  await expect(page.getByTestId('sandbox-policy-preview')).toContainText('cpu.weight');
  await page.getByTestId('sandbox-enter').click();
  await page.getByTestId('sandbox-confirm-enter').click();
  await expect(page.getByTestId('sandbox-inside')).toBeVisible();
  await selectTab(page, 'resource');
  await expect(page.getByTestId('sandbox-effective-resource-cpu.weight')).toContainText('100');
  await expect(page.getByTestId('sandbox-effective-resource-memory.high')).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web 1180 discovered cpu.weight/memory.high/io.max, accepted raw ' +
      'multi-token text, rejected cgroup.procs, and showed the observed inside readback',
  });
});

test('SC-04: a kernel-native value failure leaves the Native composer intact', async ({
  page,
}) => {
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 1180, height: 900 });
  await openWebSandbox(page, '&sandbox=enter-fail');
  await selectTab(page, 'resource');
  await page.getByTestId('sandbox-resource-add').click();
  await page.getByTestId('sandbox-resource-key-0').fill('cpu.weight');
  await page.getByTestId('sandbox-resource-value-0').fill('100');
  await selectTab(page, 'overview');
  await page.getByTestId('sandbox-preflight').click();
  await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
  await page.getByTestId('sandbox-enter').click();
  await page.getByTestId('sandbox-confirm-enter').click();
  await expect(page.getByTestId('sandbox-enter-error')).toContainText('os error 22');
  await page.getByTestId('sandbox-cancel-confirm').click();
  await expect(page.getByTestId('sandbox-composer')).toBeVisible();
  await expect(page.getByTestId('sandbox-inside')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a post-preflight kernel EINVAL kept the Native composer and ' +
      'never claimed an inside execution',
  });
});

test('SC-04: App offers discovered files and the observed readback at 390/375', async ({
  page,
}) => {
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 390, height: 844 });
  await openAppSandbox(page);
  await selectTab(page, 'resource');
  for (const key of ['cpu.weight', 'memory.high']) {
    await expect(
      page.locator(`#sandbox-resource-key-options option[value="${key}"]`),
    ).toHaveCount(1);
  }
  await page.getByTestId('sandbox-resource-add').click();
  await page.getByTestId('sandbox-resource-key-0').fill('cpu.max');
  await page.getByTestId('sandbox-resource-value-0').fill('200000 100000');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 375, height: 812 });
  await openAppSandbox(page, '?sandbox=inside');
  await selectTab(page, 'resource');
  await expect(page.getByTestId('sandbox-effective-resource-cpu.weight')).toContainText('100');
  await expect(page.getByTestId('sandbox-effective-resource-memory.high')).toBeVisible();
  await expect(page.getByTestId('sandbox-resource-add')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 390 offered the discovered files and raw text without ' +
      'overflow; App 375 showed the read-only inside readback with no draft editor',
  });
});
