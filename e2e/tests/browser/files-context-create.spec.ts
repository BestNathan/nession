// #2751 — Files operation context, create-only writes and safe edits.
//
// The canonical fixture's FileOps is in-memory and mutable, so these flows can
// create, reveal and conflict without a network or the Agent host. The
// `window.fixtureFiles` control is the fixture's stand-in for a competing
// writer; it is not product surface.
import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    fixtureFiles?: {
      reset: () => void;
      revisionOf: (path: string) => string;
      writeExternal: (path: string, content: string) => void;
    };
  }
}

async function openWebFiles(page: Page): Promise<void> {
  await page.goto('/#/fixture/workspace?capability=files');
  await expect(page.getByTestId('file-workspace')).toBeVisible();
  await expect(page.getByTestId('files-web-layout')).toBeVisible();
}

async function clickTree(page: Page, name: string): Promise<void> {
  await page
    .locator('[data-testid="file-workspace"] [role="tree"]')
    .getByText(name, { exact: true })
    .first()
    .click();
}

test('Web: creation follows the captured selection/right-click target, create-only', async ({ page }) => {
  await openWebFiles(page);

  // Expand web -> src, then select the directory and create inside it.
  await clickTree(page, 'web');
  await clickTree(page, 'src');
  await expect(page.getByTestId('file-workspace')).toContainText('App.tsx');

  await page.getByLabel('New file').click();
  await expect(page.getByTestId('files-create-destination')).toHaveText('In web/src');
  await page.getByLabel('New file name').fill('e2e-created.txt');
  await expect(page.getByTestId('files-create-destination')).toContainText(
    'web/src/e2e-created.txt',
  );
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('e2e-created.txt', { exact: true })).toBeVisible();

  // Duplicate: create-only refuses and the form keeps the typed name.
  await page.getByLabel('New file').click();
  await page.getByLabel('New file name').fill('e2e-created.txt');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('files-create-error')).toContainText('already exists');
  await expect(page.getByLabel('New file name')).toHaveValue('e2e-created.txt');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // A selected file resolves to its parent.
  await clickTree(page, 'App.tsx');
  await page.getByLabel('New folder').click();
  await expect(page.getByTestId('files-create-destination')).toHaveText('In web/src');
  await page.getByLabel('New folder name').fill('e2e-folder');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('e2e-folder', { exact: true })).toBeVisible();

  // Right-click a directory: its own menu target wins over the selection.
  // The fixture's `web/src/app` directory is labelled `session-first`.
  await clickTree(page, 'session-first');
  const appDir = page
    .locator('[data-testid="file-workspace"] [role="tree"]')
    .getByText('session-first', { exact: true })
    .first();
  await appDir.click({ button: 'right' });
  await page.getByText('New file here').click();
  await expect(page.getByTestId('files-create-destination')).toHaveText('In web/src/app');
  await page.getByLabel('New file name').fill('inside.ts');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('inside.ts', { exact: true })).toBeVisible();
});

test('Web: a save against a changed file offers reload/overwrite', async ({ page }) => {
  await openWebFiles(page);
  await clickTree(page, 'web');
  await clickTree(page, 'src');
  await clickTree(page, 'index.css');

  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('X');

  await page.evaluate(() => {
    window.fixtureFiles?.writeExternal('web/src/index.css', 'external change');
  });
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByTestId('file-conflict-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Reload file' }).click();
  await expect(page.getByTestId('file-conflict-dialog')).toBeHidden();
  await expect(page.locator('.cm-content')).toContainText('external change');
});

test('App: create in the pushed folder, read-first viewer, unsaved guard', async ({ page }) => {
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();

  await page.getByTestId('file-row-web').click();
  await page.getByTestId('file-row-web/src').click();
  await expect(page.getByTestId('files-app-list')).toContainText('App.tsx');

  await page.getByLabel('Folder actions').click();
  await expect(page.getByTestId('files-app-folder-sheet')).toBeVisible();
  await page.getByRole('button', { name: 'New file' }).click();
  await expect(page.getByTestId('app-files-create-destination')).toHaveText(
    'In web/src',
  );
  await page.getByLabel('New file name').fill('app-e2e.txt');
  await page.getByRole('button', { name: 'Create' }).click();

  // The created file is pushed read-first: Edit is offered, Save is not shown
  // until the user explicitly edits.
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('draft');

  // Leaving the pushed detail with unsaved edits asks first.
  await page.getByTestId('app-page-back').click();
  await expect(page.getByRole('alertdialog')).toContainText('Unsaved changes');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
});
