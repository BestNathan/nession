'use strict';
// #2751 SC-03: the App navigator creates in the current pushed directory,
// opens files read-first with an explicit Edit, and guards unsaved edits on
// the way back.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-03: App pushed-directory creation, read-first viewer and unsaved guard', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-03');

  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();

  // Push web -> src; the current directory is the create default.
  await page.getByTestId('file-row-web').click();
  await page.getByTestId('file-row-web/src').click();
  await expect(page.getByTestId('files-app-list')).toContainText('App.tsx');

  await page.getByLabel('Folder actions').click();
  await expect(page.getByTestId('files-app-folder-sheet')).toBeVisible();
  await page.getByRole('button', { name: 'New file' }).click();
  await expect(page.getByTestId('app-files-create-destination')).toHaveText('In web/src');
  await page.getByLabel('New file name').fill('sc03-created.txt');
  await expect(page.getByTestId('app-files-create-destination')).toContainText(
    'web/src/sc03-created.txt',
  );
  await page.getByRole('button', { name: 'Create' }).click();

  // Read-first: the created file opens with Edit offered and no Save until the
  // user explicitly edits.
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('draft');

  // Returning with unsaved edits asks first; cancelling preserves them.
  await page.getByTestId('app-page-back').click();
  await expect(page.getByRole('alertdialog')).toContainText('Unsaved changes');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the App created a file in the pushed web/src directory with the ' +
      'destination shown before submit, pushed it read-first (Edit visible, Save absent), then ' +
      'kept the edit behind the unsaved-changes guard when leaving, and cancelling preserved it',
  });
});
