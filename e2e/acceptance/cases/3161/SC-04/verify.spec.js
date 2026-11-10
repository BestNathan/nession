'use strict';
// #3161 SC-04: the Workspace renders every registered policy implementation
// with its Agent-measured status and reason. Available implementations stay
// editable; unavailable/unknown ones remain discoverable but their controls are
// disabled. Web and App share the same contract, and the inside projection
// stays read-only and distinct.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test.setTimeout(180_000);

const PATHS = [
  'filesystem.access',
  'filesystem.composition',
  'network',
  'process.linux_namespaces',
  'resource.cgroup_v2',
  'syscall.seccomp',
];

test('SC-04: Web 1180 shows each implementation status and only disables measured-unavailable controls', async ({
  page,
}) => {
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto('/#/fixture/workspace?capability=sandbox');

  for (const path of PATHS) {
    await expect(page.getByTestId(`sandbox-implementation-status-${path}`)).toHaveText(
      'available',
    );
  }
  await expect(page.getByTestId('sandbox-fs-read')).toBeEnabled();
  await expect(page.getByTestId('sandbox-network-mode')).toBeEnabled();
  await expect(page.getByTestId('sandbox-namespace-pid')).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.getByTestId('sandbox-resource-add')).toBeEnabled();
  await expect(page.getByTestId('sandbox-syscall-add')).toBeEnabled();

  // macOS: Linux-native implementations are measured unavailable, while its
  // network policy and measured allow/deny modes remain editable.
  await page.goto('/#/fixture/workspace?capability=sandbox&sandbox=macos');
  await expect(page.getByTestId('sandbox-implementation-status-filesystem.access')).toHaveText(
    'unavailable',
  );
  await expect(page.getByTestId('sandbox-implementation-status-network')).toHaveText(
    'available',
  );
  for (const path of ['process.linux_namespaces', 'resource.cgroup_v2', 'syscall.seccomp']) {
    await expect(page.getByTestId(`sandbox-implementation-status-${path}`)).toHaveText(
      'unavailable',
    );
  }
  await expect(page.getByTestId('sandbox-fs-read')).toBeDisabled();
  await expect(page.getByTestId('sandbox-fs-write')).toBeDisabled();
  await expect(page.getByTestId('sandbox-resource-add')).toBeDisabled();
  await expect(page.getByTestId('sandbox-syscall-add')).toBeDisabled();
  await expect(page.getByTestId('sandbox-namespace-pid')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.getByTestId('sandbox-network-mode').click();
  await expect(page.getByTestId('sandbox-network-mode-deny')).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.getByTestId('sandbox-network-mode-restricted')).toHaveAttribute(
    'aria-disabled',
    'true',
  );

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web 1180 rendered per-implementation status and reasons; ' +
      'macOS kept network editable while every Linux-native implementation and restricted mode was disabled',
  });
});

test('SC-04: a measured-unavailable cgroup field cannot be edited or sent', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto('/#/fixture/workspace?capability=sandbox&sandbox=limited');

  await expect(page.getByTestId('sandbox-implementation-status-resource.cgroup_v2')).toHaveText(
    'available',
  );
  await page.getByTestId('sandbox-resource-add').click();
  await page.getByTestId('sandbox-resource-key-0').fill('cpu.max');
  await expect(page.getByTestId('sandbox-resource-value-0')).toBeDisabled();
  await expect(page.getByTestId('sandbox-resource-value-unavailable-0')).toContainText(
    'not delegated',
  );
  await page.getByTestId('sandbox-preflight').click();
  await expect(page.getByTestId('sandbox-preflight-errors')).toContainText('not installable');
  await expect(page.getByTestId('sandbox-enter')).toBeDisabled();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web 1180 kept the partially delegated cgroup implementation ' +
      'editable but disabled the measured-unavailable cpu.max value and refused the draft',
  });
});

test('SC-04: unknown and inside states stay truthful and read-only', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 1180, height: 900 });

  await page.goto('/#/fixture/workspace?capability=sandbox&sandbox=offline');
  await expect(page.getByTestId('sandbox-context-error')).toBeVisible();
  await expect(page.getByTestId('sandbox-inside')).toHaveCount(0);
  await expect(page.getByTestId('sandbox-enter')).toHaveCount(0);

  await page.goto('/#/fixture/workspace?capability=sandbox&sandbox=inside');
  await expect(page.getByTestId('sandbox-inside')).toBeVisible();
  await expect(page.getByTestId('sandbox-effective-network-mode')).toHaveText('deny');
  await expect(page.getByTestId('sandbox-scope-note')).toContainText(
    'future Panes or Windows are not inside this Sandbox',
  );
  await expect(page.getByTestId('sandbox-composer')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': offline/unknown claimed no protection and offered no Enter; ' +
      'the inside projection stayed read-only effective policy with an explicit Pane scope',
  });
});

test('SC-04: App 390 renders implementation status and disables unavailable controls', async ({
  page,
}) => {
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app?sandbox=macos');
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();

  await expect(
    page.getByTestId('sandbox-implementation-status-filesystem.access'),
  ).toHaveText('unavailable');
  await expect(page.getByTestId('sandbox-implementation-status-network')).toHaveText(
    'available',
  );
  await expect(page.getByTestId('sandbox-fs-read')).toBeDisabled();
  await expect(page.getByTestId('sandbox-resource-add')).toBeDisabled();
  await expect(page.getByTestId('sandbox-syscall-add')).toBeDisabled();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('app-page-back')).toHaveCount(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 390 showed the same implementation statuses with disabled ' +
      'unavailable controls, no horizontal overflow, and the host-owned single Back',
  });
});
