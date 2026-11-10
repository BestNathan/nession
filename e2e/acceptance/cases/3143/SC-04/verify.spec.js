'use strict';
// #3143 SC-04: each peer tab keeps its domain management surface — filesystem
// path CRUD, network mode/rule CRUD, process namespace switches, native cgroup
// KV, a registered seccomp profile choice, and read-only prepared EROFS inside.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openWebSandbox,
  selectTab,
} = require('../../../shared/sandbox-tabs-browser.cjs');

test.setTimeout(180_000);

test('SC-04: filesystem, network, process, resource and syscall management', async ({
  page,
}) => {
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 1180, height: 900 });
  await openWebSandbox(page);

  // Filesystem paths: explicit Add/Edit/Remove for both lists.
  await selectTab(page, 'filesystem');
  await page.getByTestId('sandbox-fs-read-add').click();
  await page.getByTestId('sandbox-fs-read-0').fill('/usr');
  await page.getByTestId('sandbox-fs-read-add').click();
  await page.getByTestId('sandbox-fs-read-1').fill('/bin');
  await page.getByTestId('sandbox-fs-read-remove-0').click();
  await expect(page.getByTestId('sandbox-fs-read-0')).toHaveValue('/bin');
  await page.getByTestId('sandbox-fs-write-add').click();
  await page.getByTestId('sandbox-fs-write-0').fill('/workspace');

  // Network: mode + conditional egress rule CRUD.
  await selectTab(page, 'network');
  await page.getByTestId('sandbox-network-mode').click();
  await page.getByTestId('sandbox-network-mode-restricted').click();
  await page.getByTestId('sandbox-egress-allow-add').click();
  await page.getByTestId('sandbox-egress-allow-0').fill('api.example.com:443');
  await page.getByTestId('sandbox-egress-deny-add').click();
  await page.getByTestId('sandbox-egress-deny-0').fill('*.internal.example');
  await expect(page.getByTestId('sandbox-egress-allow-0')).toHaveValue(
    'api.example.com:443',
  );
  await page.getByTestId('sandbox-egress-deny-remove-0').click();
  await expect(page.getByTestId('sandbox-egress-deny-empty')).toBeVisible();

  // Process: independent namespace switches.
  await selectTab(page, 'process');
  await page.getByTestId('sandbox-namespace-pid').click();
  await expect(page.getByTestId('sandbox-namespace-pid')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByTestId('sandbox-namespace-uts').click();
  await expect(page.getByTestId('sandbox-namespace-uts')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByTestId('sandbox-namespace-uts').click();
  await expect(page.getByTestId('sandbox-namespace-uts')).not.toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Resource: native cgroup key/value CRUD.
  await selectTab(page, 'resource');
  await page.getByTestId('sandbox-resource-add').click();
  await page.getByTestId('sandbox-resource-key-0').fill('memory.max');
  await page.getByTestId('sandbox-resource-value-0').fill('2147483648');
  await page.getByTestId('sandbox-resource-add').click();
  await page.getByTestId('sandbox-resource-key-1').fill('pids.max');
  await page.getByTestId('sandbox-resource-value-1').fill('256');
  await page.getByTestId('sandbox-resource-remove-0').click();
  await expect(page.getByTestId('sandbox-resource-key-0')).toHaveValue('pids.max');

  // Syscall: one registered profile, selectable and clearable.
  await selectTab(page, 'syscall');
  await page.getByTestId('sandbox-syscall-profile').click();
  await page.getByTestId('sandbox-syscall-profile-nession-interactive-v1').click();
  await expect(page.getByTestId('sandbox-syscall-profile')).toContainText(
    'nession-interactive-v1',
  );
  await page.getByTestId('sandbox-syscall-profile').click();
  await page.getByTestId('sandbox-syscall-profile-none').click();
  await expect(page.getByTestId('sandbox-syscall-profile')).toContainText('No profile');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': every peer tab performed its own CRUD/management — path lists, ' +
      'network mode and egress rules, namespace switches, cgroup KV and the registered profile',
  });
});

test('SC-04: prepared EROFS is read-only inside its fixture', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 1180, height: 900 });
  await openWebSandbox(page, '&sandbox=inside-erofs');
  await expect(page.getByTestId('sandbox-inside')).toBeVisible();
  await selectTab(page, 'filesystem');
  await expect(page.getByTestId('sandbox-effective-erofs')).toBeVisible();
  await expect(page.getByTestId('sandbox-effective-erofs')).toContainText(
    'Prepared root composition',
  );
  await expect(page.getByTestId('sandbox-fs-read-add')).toHaveCount(0);
  await expect(page.getByTestId('sandbox-fs-write-add')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the inside Filesystem tab showed the observed prepared EROFS ' +
      'composition as read-only evidence with no editable path controls',
  });
});
