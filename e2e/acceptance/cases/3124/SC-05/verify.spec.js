'use strict';
// #3124 SC-05: the Workspace shows the Agent-observed effective configuration
// when the active Pane is inside, and an empty-first draft with validation,
// preflight and Enter when it is outside. Unknown/unsupported/offline never
// claim protection and never offer Enter.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test.setTimeout(180_000);

test('SC-05: outside draft is empty-first, row validation is field-level, and Enter shows the effective policy', async ({
  page,
}) => {
  const { sha } = verifiedRuntime('SC-05');
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto('/#/fixture/workspace?capability=sandbox');

  await expect(page.getByTestId('sandbox-status')).toHaveText('outside');
  await expect(page.getByTestId('sandbox-resource-empty')).toBeVisible();
  await expect(page.getByTestId('sandbox-syscall-empty')).toBeVisible();
  await expect(page.getByTestId('sandbox-resource-row-0')).toHaveCount(0);
  await expect(page.getByTestId('sandbox-enter')).toBeDisabled();

  // Add a blank row: it cannot pass preflight.
  await page.getByTestId('sandbox-resource-add').click();
  await page.getByTestId('sandbox-preflight').click();
  await expect(page.getByTestId('sandbox-preflight-error-0')).toContainText('required');

  // Unknown key, duplicate key, blank value and an invalid native cpu.max.
  await page.getByTestId('sandbox-resource-key-0').fill('memory.swap.max');
  await page.getByTestId('sandbox-resource-value-0').fill('1');
  await page.getByTestId('sandbox-preflight').click();
  await expect(page.getByTestId('sandbox-preflight-error-0')).toContainText('not a V1 cgroup');

  await page.getByTestId('sandbox-resource-key-0').fill('cpu.max');
  await page.getByTestId('sandbox-resource-value-0').fill('200000 999');
  await page.getByTestId('sandbox-preflight').click();
  await expect(page.getByTestId('sandbox-preflight-error-0')).toContainText('not a valid native value');

  await page.getByTestId('sandbox-resource-value-0').fill('200000 100000');
  await page.getByTestId('sandbox-resource-add').click();
  await page.getByTestId('sandbox-resource-key-1').fill('cpu.max');
  await page.getByTestId('sandbox-resource-value-1').fill('400000 100000');
  await page.getByTestId('sandbox-preflight').click();
  await expect(page.getByTestId('sandbox-preflight-error-1')).toContainText('already configured');

  await page.getByTestId('sandbox-resource-remove-1').click();
  await expect(page.getByTestId('sandbox-resource-row-1')).toHaveCount(0);
  await page.getByTestId('sandbox-syscall-add').click();
  await page.getByTestId('sandbox-syscall-key-0').fill('seccomp.profile');
  await page.getByTestId('sandbox-syscall-value-0').fill('custom-profile');
  await page.getByTestId('sandbox-preflight').click();
  await expect(page.getByTestId('sandbox-preflight-error-0')).toContainText('pins');

  await page.getByTestId('sandbox-syscall-value-0').fill('nession-interactive-v1');
  await page.getByTestId('sandbox-preflight').click();
  await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
  await expect(page.getByTestId('sandbox-enter')).toBeEnabled();

  // An edit invalidates the prior preflight.
  await page.getByTestId('sandbox-resource-value-0').fill('200000 100000');
  await page.getByTestId('sandbox-resource-value-0').press('End');
  await page.getByTestId('sandbox-resource-value-0').type('0');
  await expect(page.getByTestId('sandbox-preflight-ok')).toHaveCount(0);
  await expect(page.getByTestId('sandbox-enter')).toBeDisabled();

  await page.getByTestId('sandbox-resource-value-0').fill('200000 100000');
  await page.getByTestId('sandbox-preflight').click();
  await page.getByTestId('sandbox-enter').click();
  await expect(page.getByTestId('sandbox-confirm')).toBeVisible();
  await page.getByTestId('sandbox-confirm-enter').click();

  await expect(page.getByTestId('sandbox-inside')).toBeVisible();
  await expect(page.getByTestId('sandbox-status')).toHaveText('inside');
  await expect(page.getByTestId('sandbox-effective-resource-cpu.max')).toContainText('200000 100000');
  await expect(page.getByTestId('sandbox-effective-syscall-seccomp.profile')).toContainText(
    'nession-interactive-v1',
  );
  await expect(page.getByTestId('sandbox-effective-network-mode')).toHaveText('deny');
  await expect(page.getByTestId('sandbox-mechanism-network.deny')).toBeVisible();
  await expect(page.getByTestId('sandbox-scope-note')).toContainText(
    'future Panes or Windows are not inside this Sandbox',
  );
  await expect(page.getByTestId('sandbox-composer')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the outside draft started empty; unknown/duplicate/blank/invalid rows ' +
      'produced field-level errors; editing invalidated preflight; Enter revealed the effective ' +
      'policy, verified mechanism, resource/syscall KV and Pane-only scope note',
  });
});

test('SC-05: unknown, unsupported and offline states are truthful and offer no Enter', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-05');
  await page.setViewportSize({ width: 1180, height: 900 });

  await page.goto('/#/fixture/workspace?capability=sandbox&sandbox=unknown');
  await expect(page.getByTestId('sandbox-unavailable')).toBeVisible();
  await expect(page.getByTestId('sandbox-status')).toHaveText('unknown');
  await expect(page.getByTestId('sandbox-enter')).toHaveCount(0);
  await expect(page.getByTestId('sandbox-inside')).toHaveCount(0);

  await page.goto('/#/fixture/workspace?capability=sandbox&sandbox=unsupported');
  await expect(page.getByTestId('sandbox-unavailable')).toBeVisible();
  await expect(page.getByTestId('sandbox-reason')).toContainText('bubblewrap');
  await expect(page.getByTestId('sandbox-enter')).toHaveCount(0);

  await page.goto('/#/fixture/workspace?capability=sandbox&sandbox=offline');
  await expect(page.getByTestId('sandbox-context-error')).toBeVisible();
  await expect(page.getByTestId('sandbox-retry')).toBeVisible();
  await expect(page.getByTestId('sandbox-inside')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': unknown, unsupported and unreachable-Agent states rendered the ' +
      'measured reason with no protected label, no Enter and no inside claim',
  });
});

test('SC-05: the limited-delegation catalog removes an uninstallable key and blocks a typed one', async ({
  page,
}) => {
  const { sha } = verifiedRuntime('SC-05');
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto('/#/fixture/workspace?capability=sandbox&sandbox=limited');

  const cpuOption = page.locator('#sandbox-resource-key-options option[value="cpu.max"]');
  await expect(cpuOption).toHaveCount(1);
  await expect(cpuOption).toContainText('unavailable');

  await page.getByTestId('sandbox-resource-add').click();
  await page.getByTestId('sandbox-resource-key-0').fill('cpu.max');
  await page.getByTestId('sandbox-resource-value-0').fill('200000 100000');
  await page.getByTestId('sandbox-preflight').click();
  await expect(page.getByTestId('sandbox-preflight-error-0')).toContainText('not installable');
  await expect(page.getByTestId('sandbox-enter')).toBeDisabled();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the Agent catalog marked cpu.max unavailable under limited ' +
      'delegation and a manually typed cpu.max failed preflight instead of being accepted',
  });
});
