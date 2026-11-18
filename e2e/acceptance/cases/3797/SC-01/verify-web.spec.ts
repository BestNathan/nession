// #3797 SC-01 (Web): selecting a managed Workspace exposes its ordered source
// image lowers, durable writable-store identity, measured usage, lease/mount
// state, linked Session consumers, Agent identity and update time. A Project
// Existing Location stays visibly user-owned with no delete action.
import { expect, test } from '@playwright/test';

test('SC-01: managed Workspace detail separates ownership, lowers, usage and consumers', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await page.setViewportSize({ width: 1180, height: 900 });

  await page.goto('/#/fixture/workspace?capability=sandbox');
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await page.getByTestId('sandbox-section-workspaces').click();
  await expect(page.getByTestId('sandbox-workspaces')).toBeVisible();
  await expect(page.getByTestId('sandbox-workspace-row')).toHaveCount(3);

  const available = page
    .getByTestId('sandbox-workspace-row')
    .filter({ hasText: 'fixture-workspace' });
  await available.getByTestId('sandbox-workspace-row-select').click();
  const detail = page.getByTestId('sandbox-workspace-detail');
  await expect(detail.getByTestId('sandbox-workspace-detail-ownership')).toHaveText(
    'Agent-managed',
  );
  await expect(detail.getByTestId('sandbox-workspace-detail-agent')).toHaveText('devbox-01');
  await expect(detail.getByTestId('sandbox-workspace-detail-store')).toContainText(
    'ws_00000000-0000-4000-8000-000000000001',
  );
  await expect(detail.getByTestId('sandbox-workspace-detail-store')).toContainText(
    'durable Overlay upper/work',
  );
  await expect(detail.getByTestId('sandbox-workspace-detail-bytes')).toContainText(
    '2,097,152 bytes',
  );
  await expect(detail.getByTestId('sandbox-workspace-detail-use')).toContainText(
    'Available · 0 leases · not mounted',
  );
  await expect(detail.getByTestId('sandbox-workspace-detail-consumers')).toHaveText(
    'No Session consumer observed',
  );
  await expect(detail.getByTestId('sandbox-workspace-detail-lower-0')).toContainText('sha256:');

  const leased = page
    .getByTestId('sandbox-workspace-row')
    .filter({ hasText: 'fixture-session-auto' });
  await leased.getByTestId('sandbox-workspace-row-select').click();
  await expect(page.getByTestId('sandbox-workspace-detail-use')).toContainText(
    'In use · 1 lease · mounted',
  );
  await expect(page.getByTestId('sandbox-workspace-detail-consumers')).toHaveText(
    'fixture-session',
  );
  await expect(page.getByTestId('sandbox-workspace-detail-lower-0')).toBeVisible();
  await expect(page.getByTestId('sandbox-workspace-detail-lower-1')).toBeVisible();
  await expect(leased.getByTestId('sandbox-workspace-delete')).toBeDisabled();

  const location = page
    .getByTestId('sandbox-workspace-row')
    .filter({ hasText: 'user-owned' });
  await location.getByTestId('sandbox-workspace-row-select').click();
  await expect(page.getByTestId('sandbox-workspace-detail-ownership')).toHaveText(
    'Project Location · user-owned',
  );
  await expect(page.getByTestId('sandbox-workspace-detail-path')).toHaveText(
    '/Users/nathan/code/nession',
  );
  await expect(location.getByTestId('sandbox-workspace-no-delete')).toBeVisible();
  await expect(location.getByTestId('sandbox-workspace-delete')).toHaveCount(0);
  await expect(page.getByTestId('sandbox-workspace-detail-bytes')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a selected managed Workspace exposed Agent ownership, its ws_ ' +
      'store identity, durable Overlay storage, measured 2,097,152 bytes, ordered source image ' +
      'lowers, lease/mount state and its linked Session; the Project Existing Location stayed ' +
      'user-owned with no delete action',
  });
});
