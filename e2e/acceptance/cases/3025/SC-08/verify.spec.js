'use strict';
// #3025 SC-08: Web Projects expose + Create (name only), multiple-project
// navigation, row ··· Settings/Rename/Delete, explicit confirmation, and a
// standalone detail — without deleting or re-parenting any Session.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-08: create, navigate, settings, rename and confirm a Project delete', async ({ page }) => {
  test.setTimeout(300_000);
  const { sha } = verifiedRuntime('SC-08');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=canonical');

  await expect(page.getByTestId('projects-section')).toBeVisible();
  await expect(page.getByTestId('project-item-row')).toHaveCount(2);
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);

  // Multiple existing Projects are independently selectable.
  await page.getByTestId('project-item-row').first().click();
  await expect(page.getByTestId('project-detail-title')).toHaveText('Nession');
  await page.getByTestId('project-item-row').nth(1).click();
  await expect(page.getByTestId('project-detail-title')).toHaveText('Ops notes');

  // Name-only create is sufficient and selects the new declaration.
  await page.getByTestId('project-create').click();
  const createDialog = page.getByRole('dialog').filter({ hasText: 'Create Project' });
  await expect(createDialog).toBeVisible();
  await createDialog.locator('#project-create-name').fill('Managed Notes');
  await createDialog.getByTestId('project-create-submit').click();
  await expect(page.getByTestId('project-detail-title')).toHaveText('Managed Notes');
  await expect(page.getByTestId('project-item-row')).toHaveCount(3);
  const newRow = page.getByTestId('project-item-row').filter({ hasText: 'Managed Notes' });
  const projectId = await newRow.getAttribute('data-project-id');
  expect(projectId).toBeTruthy();

  // The row menu owns Settings and Rename.
  await page.getByTestId(`project-actions-${projectId}`).click();
  await page.getByTestId(`project-actions-settings-${projectId}`).click();
  const settings = page.getByRole('dialog').filter({ hasText: 'Project settings' });
  await expect(settings.locator('#project-settings-name')).toHaveValue('Managed Notes');
  await settings.getByRole('button', { name: 'Cancel' }).click();
  await expect(settings).toHaveCount(0);

  await page.getByTestId(`project-actions-${projectId}`).click();
  await page.getByTestId(`project-actions-rename-${projectId}`).click();
  const renameDialog = page.getByRole('dialog').filter({ hasText: 'Rename Project' });
  await renameDialog.locator('#project-rename-name').fill('Renamed Notes');
  await renameDialog.getByTestId('project-rename-submit').click();
  await expect(page.getByTestId('project-item-row').filter({ hasText: 'Renamed Notes' }))
    .toHaveCount(1);
  await expect(page.getByTestId('project-detail-title')).toHaveText('Renamed Notes');

  // Delete is explicit: cancel keeps it, confirm removes only the declaration.
  await page.getByTestId(`project-actions-${projectId}`).click();
  await page.getByTestId(`project-actions-delete-${projectId}`).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('Renamed Notes');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('project-item-row')).toHaveCount(3);
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);

  await page.getByTestId(`project-actions-${projectId}`).click();
  await page.getByTestId(`project-actions-delete-${projectId}`).click();
  await page.getByTestId('project-delete-confirm').click();
  await expect(page.getByTestId('project-item-row')).toHaveCount(2);
  await expect(page.getByTestId('project-detail')).toHaveCount(0);
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web 1440x900 created name-only Project ' + projectId +
      ' and selected it; Settings opened with the stored name; Rename updated the row and the ' +
      'standalone detail; Delete cancel preserved 3 Projects; confirm removed only that ' +
      'declaration, left 2 Projects and all 6 Session rows untouched',
  });
});
