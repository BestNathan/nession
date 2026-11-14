// #3407 SC-05: in a Session-scoped Sandbox Web/App UI, the current Agent's
// reusable Workspace inventory (including auto-created entries), statuses and
// safe actions can be inspected; Filesystem can select one without duplicating
// the registry, with truthful leased-deletion/confirmation states and no
// invented global entry.
import { expect, test } from '@playwright/test';

const FIXTURE_WORKSPACE = 'ws_00000000-0000-4000-8000-000000000001';

test('SC-05: Workspace inventory, safe actions and Filesystem selection (Web/App)', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await page.setViewportSize({ width: 1180, height: 900 });

  await page.goto('/#/fixture/workspace?capability=sandbox');
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  // No separate global Images entry; the registry is rendered inside Sandbox.
  await expect(page.getByTestId('workspace-tool-images')).toHaveCount(0);

  // ── Inventory: auto-created, available and leased entries ──
  await page.getByTestId('sandbox-section-workspaces').click();
  await expect(page.getByTestId('sandbox-workspaces')).toBeVisible();
  await expect(page.getByTestId('sandbox-workspace-row')).toHaveCount(2);
  const available = page
    .getByTestId('sandbox-workspace-row')
    .filter({ hasText: 'fixture-workspace' });
  const leased = page
    .getByTestId('sandbox-workspace-row')
    .filter({ hasText: 'fixture-session-auto' });
  await expect(available.getByTestId('sandbox-workspace-status')).toHaveText('available');
  await expect(leased.getByTestId('sandbox-workspace-status')).toHaveText('in_use');
  await expect(leased.getByTestId('sandbox-workspace-auto-created')).toBeVisible();

  // ── Create and delete with a confirmation; a lease refuses deletion ──
  await page.getByTestId('sandbox-workspaces-create-name').fill('acceptance-ws');
  await page.getByTestId('sandbox-workspaces-create').click();
  await expect(page.getByTestId('sandbox-workspace-row')).toHaveCount(3);
  const created = page
    .getByTestId('sandbox-workspace-row')
    .filter({ hasText: 'acceptance-ws' });
  await created.getByTestId('sandbox-workspace-delete').click();
  await page.getByTestId('sandbox-workspace-delete-confirm').click();
  await expect(page.getByTestId('sandbox-workspace-row')).toHaveCount(2);

  await leased.getByTestId('sandbox-workspace-delete').click();
  await page.getByTestId('sandbox-workspace-delete-confirm').click();
  await expect(page.getByTestId('sandbox-workspaces-action-error')).toContainText('leased');
  await expect(page.getByTestId('sandbox-workspace-row')).toHaveCount(2);

  // ── Filesystem selects the same registry entry; no second registry ──
  await page.getByTestId('sandbox-section-policies').click();
  await page.getByTestId('sandbox-tab-filesystem').click();
  await page.getByTestId('sandbox-rootfs-image').click();
  await page.getByTestId('sandbox-image-row').first().click();
  await page.getByTestId('sandbox-image-select-submit').click();
  await page.getByTestId('sandbox-workspace-managed-select').selectOption(FIXTURE_WORKSPACE);
  await expect(page.getByTestId('sandbox-workspace-managed-selected')).toContainText(
    'fixture-workspace',
  );
  await expect(page.getByTestId('sandbox-filesystem-preview-workspace')).toContainText(
    'Managed',
  );
  await page.getByTestId('sandbox-section-workspaces').click();
  await expect(page.getByTestId('sandbox-workspace-row')).toHaveCount(2);

  // ── App: one host header, compact sections, same inventory ──
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app');
  // A hash-only navigation does not remount the fixture route; reload so the
  // App experience (and its host header) is the canonical one.
  await page.reload();
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await page.getByTestId('sandbox-section-workspaces').click();
  await expect(page.getByTestId('sandbox-workspace-row')).toHaveCount(2);
  await expect(page.getByTestId('app-page-back')).toHaveCount(1);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the Session Sandbox listed the current Agent inventory (available, ' +
      'in_use and auto-created), created and confirmed deletion of an unleased Workspace, showed ' +
      'the leased deletion refusal, selected the same stable id in Filesystem without a second ' +
      'registry, and exposed no global Images entry on Web or App',
  });
});
