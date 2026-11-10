'use strict';
// #3143 SC-06: the same tabs project only the authenticated Agent's observed
// effective data inside; unknown/offline/unsupported never imply verified
// protection; cross-domain switching still works on Web and App.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openWebSandbox,
  openAppSandbox,
  selectTab,
} = require('../../../shared/sandbox-tabs-browser.cjs');

test.setTimeout(180_000);

test('SC-06: inside tabs are read-only observed data and scoped to the Pane', async ({
  page,
}) => {
  const { sha } = verifiedRuntime('SC-06');
  await page.setViewportSize({ width: 1180, height: 900 });
  await openWebSandbox(page, '&sandbox=inside-erofs');
  await expect(page.getByTestId('sandbox-inside')).toBeVisible();
  await expect(page.getByTestId('sandbox-scope-note')).toContainText(
    'future Panes or Windows are not inside this Sandbox',
  );
  await expect(page.getByTestId('sandbox-execution-id')).toBeVisible();
  await expect(page.getByTestId('sandbox-tabs')).toBeVisible();

  const observed = {
    filesystem: 'sandbox-effective-erofs',
    network: 'sandbox-effective-network-mode',
    process: 'sandbox-effective-namespaces',
    resource: 'sandbox-effective-resource-cpu.max',
    syscall: 'sandbox-effective-syscall-seccomp.profile',
  };
  for (const [tab, testId] of Object.entries(observed)) {
    await selectTab(page, tab);
    await expect(page.getByTestId(testId)).toBeVisible();
  }
  await selectTab(page, 'resource');
  await expect(page.getByTestId('sandbox-resource-add')).toHaveCount(0);
  await selectTab(page, 'syscall');
  await expect(page.getByTestId('sandbox-syscall-profile')).toHaveCount(0);
  await selectTab(page, 'filesystem');
  await expect(page.getByTestId('sandbox-fs-read-add')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': inside Web 1180 kept the same tabs as read-only observed ' +
      'evidence only, with the Pane scope note and no editable controls',
  });
});

test('SC-06: unknown/offline/unsupported never claim verified data', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-06');
  await page.setViewportSize({ width: 1180, height: 900 });

  await openWebSandbox(page, '&sandbox=unknown');
  await expect(page.getByTestId('sandbox-unavailable')).toBeVisible();
  await expect(page.getByTestId('sandbox-status')).toHaveText('unknown');
  await expect(page.getByTestId('sandbox-tabs')).toHaveCount(0);
  await expect(page.getByTestId('sandbox-enter')).toHaveCount(0);

  await openWebSandbox(page, '&sandbox=unsupported');
  await expect(page.getByTestId('sandbox-unavailable')).toBeVisible();
  await expect(page.getByTestId('sandbox-enter')).toHaveCount(0);

  await openWebSandbox(page, '&sandbox=offline');
  await expect(page.getByTestId('sandbox-context-error')).toBeVisible();
  await expect(page.getByTestId('sandbox-inside')).toHaveCount(0);
  await expect(page.getByTestId('sandbox-tabs')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': unknown, unsupported and offline showed truthful no-Enter ' +
      'states with no tabs and no verified-data claim',
  });
});

test('SC-06: App 375 inside tabs stay read-only without horizontal overflow', async ({
  page,
}) => {
  const { sha } = verifiedRuntime('SC-06');
  await page.setViewportSize({ width: 375, height: 812 });
  await openAppSandbox(page, '?sandbox=inside');
  await expect(page.getByTestId('sandbox-inside')).toBeVisible();
  await selectTab(page, 'resource');
  await expect(page.getByTestId('sandbox-effective-resource-cpu.max')).toBeVisible();
  await expect(page.getByTestId('sandbox-resource-add')).toHaveCount(0);
  await selectTab(page, 'network');
  await expect(page.getByTestId('sandbox-effective-network-mode')).toHaveText('deny');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 375 kept inside tabs read-only across domains with no ' +
      'horizontal overflow and no draft editors',
  });
});
