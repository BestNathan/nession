// #3797 SC-01 (App): the compact App experience exposes the same selected
// Workspace detail and the same user-owned Project Location boundary.
import { expect, test } from '@playwright/test';

test('SC-01: App Workspace detail shows the observed store and no Project Location delete', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await page.getByTestId('sandbox-section-workspaces').click();
  await expect(page.getByTestId('sandbox-workspace-row')).toHaveCount(3);

  const available = page
    .getByTestId('sandbox-workspace-row')
    .filter({ hasText: 'fixture-workspace' });
  await available.getByTestId('sandbox-workspace-row-select').click();
  const detail = page.getByTestId('sandbox-workspace-detail');
  await expect(detail.getByTestId('sandbox-workspace-detail-ownership')).toHaveText(
    'Agent-managed',
  );
  await expect(detail.getByTestId('sandbox-workspace-detail-store')).toContainText('ws_');
  await expect(detail.getByTestId('sandbox-workspace-detail-bytes')).toContainText('bytes');
  await expect(detail.getByTestId('sandbox-workspace-detail-lower-0')).toContainText('sha256:');

  const location = page
    .getByTestId('sandbox-workspace-row')
    .filter({ hasText: 'user-owned' });
  await location.getByTestId('sandbox-workspace-row-select').click();
  await expect(page.getByTestId('sandbox-workspace-detail-ownership')).toHaveText(
    'Project Location · user-owned',
  );
  await expect(location.getByTestId('sandbox-workspace-no-delete')).toBeVisible();
  await expect(location.getByTestId('sandbox-workspace-delete')).toHaveCount(0);
  await expect(page.getByTestId('app-page-back')).toHaveCount(1);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the App Workspace section expanded the same managed store, ' +
      'measured bytes and source lowers; the Project Existing Location stayed user-owned with ' +
      'no delete action and the App page kept one Back depth',
  });
});
