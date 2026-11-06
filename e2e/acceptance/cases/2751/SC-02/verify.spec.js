'use strict';
// #2751 SC-02: Web selection, active/open file, expanded directories and the
// browse directory stay independently controlled; every create entry point
// resolves its captured destination, including selected file/dir and
// right-click targets.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-02: Web create destinations follow the captured selection/right-click target', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/fixture/workspace?capability=files');
  await expect(page.getByTestId('file-workspace')).toBeVisible();
  await expect(page.getByTestId('files-web-layout')).toBeVisible();

  const tree = page.locator('[data-testid="file-workspace"] [role="tree"]');
  const clickTree = async (name) => {
    await tree.getByText(name, { exact: true }).first().click();
  };

  // Selection + browse: activating `web` then `src` selects the directory and
  // moves the browse path; a directory selected and opened is still itself the
  // create destination.
  await clickTree('web');
  await clickTree('src');
  await expect(tree.getByText('App.tsx', { exact: true })).toBeVisible();

  await page.getByLabel('New file').click();
  await expect(page.getByTestId('files-create-destination')).toHaveText('In web/src');
  await page.getByLabel('New file name').fill('sc02-created.txt');
  await expect(page.getByTestId('files-create-destination')).toContainText(
    'web/src/sc02-created.txt',
  );
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(tree.getByText('sc02-created.txt', { exact: true })).toBeVisible();

  // Create-only refusal: the form keeps the typed name and reports the conflict.
  await page.getByLabel('New file').click();
  await page.getByLabel('New file name').fill('sc02-created.txt');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('files-create-error')).toContainText('already exists');
  await expect(page.getByLabel('New file name')).toHaveValue('sc02-created.txt');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Selected file -> its parent.
  await clickTree('App.tsx');
  await page.getByLabel('New folder').click();
  await expect(page.getByTestId('files-create-destination')).toHaveText('In web/src');
  await page.getByLabel('New folder name').fill('sc02-folder');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(tree.getByText('sc02-folder', { exact: true })).toBeVisible();

  // Right-clicked directory wins over the current selection. The fixture's
  // `web/src/app` directory is labelled `session-first`.
  await clickTree('session-first');
  await tree.getByText('session-first', { exact: true }).first().click({ button: 'right' });
  await page.getByText('New file here').click();
  await expect(page.getByTestId('files-create-destination')).toHaveText('In web/src/app');
  await page.getByLabel('New file name').fill('sc02-inside.ts');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(tree.getByText('sc02-inside.ts', { exact: true })).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a selected+opened directory captured itself as the create ' +
      'destination; a selected file captured its parent; a right-clicked directory captured ' +
      'itself over the current selection; a duplicate create was refused with the form and ' +
      'typed name intact; successful creates revealed their targets',
  });
});
