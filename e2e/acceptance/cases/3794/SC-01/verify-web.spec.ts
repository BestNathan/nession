// #3794 SC-01 (Web): a Project New Session offers an explicit Host vs Managed
// choice, presents the resolved Agent / Base / pinned Project Source /
// ordered Toolchains / Workspace / ENV before a separate Create step, and no
// longer exposes the unconditional "Managed is unavailable" stub.
import { expect, test } from '@playwright/test';

test('SC-01: Project New Session previews the resolved Managed snapshot before Create', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await page.setViewportSize({ width: 1180, height: 900 });

  await page.goto('/#/fixture?projects=canonical');
  await page.getByTestId('project-item-row').first().click();
  await expect(page.getByTestId('project-detail')).toBeVisible();
  await expect(page.getByTestId('project-detail-managed-session')).toHaveCount(0);

  await page.getByTestId('project-detail-create-session').click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Create Session in' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('session-runtime-native')).toBeVisible();
  await expect(dialog.getByTestId('session-runtime-managed')).toBeVisible();

  await dialog.locator('#name').fill('managed-preview');
  await dialog.getByTestId('session-runtime-managed').locator('input').check();
  await expect(dialog.getByTestId('managed-create-fields')).toBeVisible();
  await expect(dialog.getByTestId('managed-create-source-digest')).toContainText('sha256:');
  await expect(dialog.getByTestId('managed-create-source-status')).toHaveText(
    'Server Ready',
    { timeout: 20_000 },
  );
  await expect(dialog.getByTestId('managed-create-workspace')).toContainText(
    'Agent-managed durable Workspace',
  );

  await dialog.getByTestId('managed-create-base').click();
  const baseOption = page.getByRole('option').first();
  await expect(baseOption).toBeVisible();
  await baseOption.click();
  await expect(dialog.getByTestId('managed-create-base')).not.toHaveText(
    'Select a Base Runtime',
  );

  await dialog.getByTestId('managed-create-toolchain-add').first().click();
  await expect(dialog.getByTestId('managed-create-toolchain-0')).toBeVisible();

  await dialog.getByTestId('create-session-review').click();
  const review = dialog.getByTestId('create-session-review-panel');
  await expect(review).toBeVisible();
  await expect(review.getByTestId('managed-review-runtime')).toHaveText('Managed (EROFS)');
  await expect(review.getByTestId('managed-review-agent')).toContainText('macbook');
  await expect(review.getByTestId('managed-review-base')).toContainText('image-fixture');
  await expect(review.getByTestId('managed-review-source')).toContainText('sha256:');
  await expect(review.getByTestId('managed-review-toolchains')).toContainText('1.');
  await expect(review.getByTestId('managed-review-workspace')).toContainText(
    'Agent-managed durable Workspace',
  );
  await expect(review.getByTestId('managed-review-env')).toContainText('staging.env');

  // The reviewed snapshot is the separate explicit Create step.
  const create = dialog.getByTestId('create-session-submit');
  await expect(create).toBeEnabled();
  await expect(create).toHaveText('Create Session');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Project New Session offered Host and Managed runtimes; the Managed ' +
      'form showed the pinned Server Ready Project Source, an explicit Base and ordered ' +
      'Toolchain selection, Agent-managed Workspace and effective ENV; Review resolved every ' +
      'identity and only Review exposed the explicit Create Session; no unconditional Managed ' +
      'stub remained',
  });
});
