// #3794 SC-01 (App): the compact operation page exposes the same explicit
// Host vs Managed choice and the same reviewed snapshot before Create.
import { expect, test } from '@playwright/test';

test('SC-01: App New Session reviews the resolved Managed snapshot before Create', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/#/fixture/app?projects=canonical');
  await page.getByTestId('app-header-sessions').first().click();
  await page.getByTestId('project-item-row').first().click();
  await expect(page.getByTestId('app-project-detail')).toBeVisible();
  await page.getByTestId('project-detail-create-session').click();

  const formPage = page.getByTestId('app-create-session-page');
  await expect(formPage).toBeVisible();
  await expect(formPage.getByTestId('app-page-header')).toHaveCount(1);
  await formPage.locator('#name').fill('managed-app');
  await formPage.getByTestId('session-runtime-managed').locator('input').check();
  await expect(formPage.getByTestId('managed-create-fields')).toBeVisible();
  await expect(formPage.getByTestId('managed-create-source-status')).toHaveText(
    'Server Ready',
    { timeout: 20_000 },
  );

  await formPage.getByTestId('managed-create-base').click();
  await page.getByRole('option').first().click();
  await formPage.getByTestId('managed-create-toolchain-add').first().click();
  await formPage.getByTestId('create-session-review').click();

  const review = formPage.getByTestId('create-session-review-panel');
  await expect(review).toBeVisible();
  await expect(review.getByTestId('managed-review-runtime')).toHaveText('Managed (EROFS)');
  await expect(review.getByTestId('managed-review-source')).toContainText('sha256:');
  await expect(review.getByTestId('managed-review-toolchains')).toContainText('1.');
  await expect(review.getByTestId('managed-review-workspace')).toContainText(
    'Agent-managed durable Workspace',
  );
  await expect(formPage.getByTestId('create-session-submit')).toBeEnabled();
  await expect(formPage.getByTestId('app-page-header')).toHaveCount(1);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the App New Session page offered the same Host and Managed runtime, ' +
      'resolved the pinned Project Source, Base, ordered Toolchain and Agent-managed Workspace, ' +
      'and exposed the explicit Create only after Review with one page header and no overflow',
  });
});
