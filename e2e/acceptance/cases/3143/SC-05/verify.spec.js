'use strict';
// #3143 SC-05: tab switching preserves the canonical draft and a fresh
// preflight; actual edits invalidate it; the assembled preview/Confirm payload
// is what Enter submits and the Native Pane is preserved.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openWebSandbox,
  selectTab,
} = require('../../../shared/sandbox-tabs-browser.cjs');

test.setTimeout(180_000);

test('SC-05: tab switches preserve draft and preflight; edits invalidate', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-05');
  await page.setViewportSize({ width: 1180, height: 900 });
  await openWebSandbox(page);

  await selectTab(page, 'resource');
  await page.getByTestId('sandbox-resource-add').click();
  await page.getByTestId('sandbox-resource-key-0').fill('cpu.max');
  await page.getByTestId('sandbox-resource-value-0').fill('200000 100000');

  await selectTab(page, 'overview');
  await page.getByTestId('sandbox-preflight').click();
  await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
  await expect(page.getByTestId('sandbox-enter')).toBeEnabled();
  await expect(page.getByTestId('sandbox-policy-preview')).toContainText('cpu.max');

  // Tab switching alone never invalidates the validation.
  await selectTab(page, 'filesystem');
  await selectTab(page, 'syscall');
  await expect(page.getByTestId('sandbox-syscall-profile')).toBeVisible();
  await selectTab(page, 'overview');
  await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
  await expect(page.getByTestId('sandbox-enter')).toBeEnabled();

  // An actual filesystem edit invalidates the preflight.
  await selectTab(page, 'filesystem');
  await page.getByTestId('sandbox-fs-read-add').click();
  await page.getByTestId('sandbox-fs-read-0').fill('/usr');
  await selectTab(page, 'overview');
  await expect(page.getByTestId('sandbox-preflight-ok')).toHaveCount(0);
  await expect(page.getByTestId('sandbox-enter')).toBeDisabled();

  // Validate the current assembled payload and confirm the same values.
  await page.getByTestId('sandbox-preflight').click();
  await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
  await expect(page.getByTestId('sandbox-enter')).toBeEnabled();
  await expect(page.getByTestId('sandbox-policy-preview')).toContainText('/usr');
  await page.getByTestId('sandbox-enter').click();
  await expect(page.getByTestId('sandbox-confirm')).toBeVisible();
  await page.getByTestId('sandbox-confirm-enter').click();
  await expect(page.getByTestId('sandbox-inside')).toBeVisible();
  await selectTab(page, 'filesystem');
  await expect(page.getByTestId('sandbox-effective-file-read')).toContainText('/usr');
  await selectTab(page, 'resource');
  await expect(page.getByTestId('sandbox-effective-resource-cpu.max')).toContainText(
    '200000 100000',
  );

  // Return to Native focuses the preserved Native Pane; the Sandbox Pane stays
  // listed in Overview.
  await selectTab(page, 'overview');
  await page.getByTestId('sandbox-return-native').click();
  await expect(page.getByTestId('sandbox-composer')).toBeVisible();
  await expect(page.getByTestId('sandbox-existing-panes')).toContainText('%2');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a validated draft survived tab switches, an actual edit ' +
      'invalidated it, and the submitted preview/Enter values matched the inside readback; ' +
      'Return to Native preserved the sibling Sandbox Pane',
  });
});
