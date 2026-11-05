'use strict';
// #2751 SC-04: against the real Agent host (P2P file RPCs, not the fixture),
// create/rename/save refuse accidental overwrites or stale edits, conflicts are
// actionable, the form/dirty state survives them, and a successful create
// reveals the target under the correct parent.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime,
  createAndAttach,
} = require('../../../shared/foreground-resume-browser.cjs');

function bumpMtime(file) {
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(file, later, later);
}

test('SC-04: real Agent file RPCs reject overwrites/stale writes and preserve user state', async ({ page }) => {
  test.setTimeout(240_000);
  const { runtime, sha } = verifiedRuntime('SC-04');
  const root = String(runtime.home || '');
  if (!root) throw new Error('the full-stack runtime must report its owned home');

  await page.setViewportSize({ width: 1440, height: 900 });

  // A real P2P attach: the Files capability only exists when the agent socket
  // is the transport, so a relay fallback would make this Case fail rather
  // than silently exercise the fixture. The harness shell is the host's, so
  // the prompt pattern is not asserted.
  await createAndAttach(page, expect, runtime, 'case2751', 'P2P', null);
  await page.getByTestId('surface-action-open-workspace').click();
  await expect(page.getByTestId('workspace-shell')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-files')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('workspace-tool-files').click();
  await expect(page.getByTestId('file-workspace')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('file-source-unavailable')).toHaveCount(0);

  const tree = page.locator('[data-testid="file-workspace"] [role="tree"]');
  const form = page.getByTestId('files-create-form');
  const submitCreate = async () => {
    await form.getByRole('button', { name: 'Create' }).click();
  };
  const folder = 'case2751-' + Date.now();

  // Create-only: a new folder at the workspace root, then a file inside it.
  await page.getByLabel('New folder').click();
  await expect(page.getByTestId('files-create-destination')).toHaveText('In Workspace root');
  await page.getByLabel('New folder name').fill(folder);
  await submitCreate();
  await expect(tree.getByText(folder, { exact: true })).toBeVisible();

  await tree.getByText(folder, { exact: true }).click();
  await page.getByLabel('New file').click();
  await expect(page.getByTestId('files-create-destination')).toHaveText('In ' + folder);
  await page.getByLabel('New file name').fill('probe.txt');
  await expect(page.getByTestId('files-create-destination')).toContainText(
    'In ' + folder + ' → ' + folder + '/probe.txt',
  );
  await submitCreate();
  await expect(tree.getByText('probe.txt', { exact: true })).toBeVisible();
  expect(fs.readFileSync(path.join(root, folder, 'probe.txt'), 'utf8')).toBe('');

  // Duplicate create: the real Agent's create-only refusal keeps the form open
  // with the typed name so the user can retype it.
  await page.getByLabel('New file').click();
  await page.getByLabel('New file name').fill('probe.txt');
  await submitCreate();
  await expect(page.getByTestId('files-create-error')).toContainText('already exists');
  await expect(page.getByLabel('New file name')).toHaveValue('probe.txt');
  await form.getByRole('button', { name: 'Cancel' }).click();

  // Keep a destination so rename has a real target to collide with.
  await page.getByLabel('New file').click();
  await page.getByLabel('New file name').fill('rename-dst.txt');
  await submitCreate();
  await expect(tree.getByText('rename-dst.txt', { exact: true })).toBeVisible();
  await page.getByLabel('New file').click();
  await page.getByLabel('New file name').fill('rename-src.txt');
  await submitCreate();
  await expect(tree.getByText('rename-src.txt', { exact: true })).toBeVisible();

  // Rename is no-replace: the collision is reported and the inline editor
  // stays open on the typed name.
  const srcRow = tree.getByText('rename-src.txt', { exact: true });
  await srcRow.click({ button: 'right' });
  await page.getByText('Rename', { exact: true }).click();
  const renameInput = tree.locator('input');
  await expect(renameInput).toBeVisible();
  await renameInput.fill('rename-dst.txt');
  await renameInput.press('Enter');
  await expect(page.getByText('Could not rename: that name already exists.').first()).toBeVisible();
  // The source was not renamed or removed: it still exists on disk and the
  // inline editor keeps the rejected name for correction.
  expect(fs.existsSync(path.join(root, folder, 'rename-src.txt'))).toBe(true);
  expect(fs.existsSync(path.join(root, folder, 'rename-dst.txt'))).toBe(true);
  await expect(renameInput).toHaveValue('rename-dst.txt');
  await renameInput.press('Escape');
  await expect(tree.getByText('rename-src.txt', { exact: true })).toBeVisible();
  await expect(tree.getByText('rename-dst.txt', { exact: true })).toBeVisible();

  // A competing writer changes the open file after its revision was read.
  const target = path.join(root, folder, 'rename-dst.txt');
  await tree.getByText('rename-dst.txt', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('local-edit');
  fs.writeFileSync(target, 'external-change');
  bumpMtime(target);
  await page.getByRole('button', { name: 'Save' }).click();

  const dialog = page.getByTestId('file-conflict-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('File changed on disk');
  // The local edit is still in the editor behind the conflict prompt.
  await expect(page.locator('.cm-content')).toContainText('local-edit');
  await page.getByRole('button', { name: 'Reload file' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.cm-content')).toContainText('external-change');
  await expect(page.locator('.cm-content')).not.toContainText('local-edit');

  // Overwrite is the explicit escape hatch: it writes the user's edit over the
  // file the competing writer changed.
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('-more');
  fs.writeFileSync(target, 'external-again');
  bumpMtime(target);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: 'Overwrite' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Saved rename-dst.txt').first()).toBeVisible();
  expect(fs.readFileSync(target, 'utf8')).toBe('external-change-more');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': real Agent file RPCs (P2P, sandbox ' + root + ') created ' +
      folder + '/probe.txt create-only and revealed it under the shown parent; a duplicate ' +
      'create was refused with the typed name intact; a no-replace rename onto an existing ' +
      'file reported "Could not rename: that name already exists." with the inline editor and ' +
      'both files preserved; a save of a stale revision opened the conflict dialog with the ' +
      'local edit intact, Reload file swapped in the external content, and Overwrite wrote the ' +
      'user edit over the competing change',
  });
});
