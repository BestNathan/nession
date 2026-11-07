'use strict';
// #2876 SC-05: tracked rows still open the Pierre patch, and Files keeps its
// code/Preview/Raw/edit lifecycle after both consume the shared presentation.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-05: Pierre diffs and the Files edit lifecycle are unchanged', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-05');

  await page.setViewportSize({ width: 1440, height: 900 });

  // Git: a tracked row is still the bounded Pierre diff, not a file viewer.
  await page.goto('/#/fixture/workspace?capability=git&git=diff-states');
  await page.getByTestId('git-change-list').waitFor();
  await page.getByTestId('git-row-tracked').first().click();
  await expect(page.getByTestId('git-diff')).toBeVisible();
  await expect(page.getByTestId('git-diff-patch')).toBeVisible();
  await expect(page.getByTestId('git-diff-patch').locator('diffs-container')).toHaveCount(1);
  await expect(page.getByTestId('file-content-code')).toHaveCount(0);
  await expect(page.getByTestId('git-diff-layout-unified')).toBeVisible();

  // Files: code view, structured Preview/Raw, and the explicit edit/save path.
  // The explorer exposes rows as treeitems; folder labels flip between
  // "Expand folder" and "Collapse folder" as they open.
  await page.goto('/#/fixture/workspace?capability=files');
  await expect(page.getByTestId('file-workspace')).toBeVisible();
  await page.getByRole('treeitem', { name: 'Expand folder web' }).click();
  await page.getByRole('treeitem', { name: 'Expand folder src' }).click();
  await page.getByRole('treeitem', { name: 'App.tsx', exact: true }).click();
  const filesEditor = page.getByTestId('codemirror-editor');
  await expect(filesEditor).toBeVisible();
  await expect(page.getByTestId('file-view-unavailable')).toHaveCount(0);

  await page.getByRole('treeitem', { name: 'Expand folder docs' }).click();
  await page.getByRole('treeitem', { name: 'Expand folder design' }).click();
  await page.getByRole('treeitem', { name: 'visual-language.md', exact: true }).click();
  const mode = page.getByRole('group', { name: 'View mode' });
  await expect(mode.getByRole('button', { name: 'Preview', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await mode.getByRole('button', { name: 'Raw', exact: true, pressed: false }).click();
  await expect(page.getByTestId('codemirror-editor')).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const content = page.locator('.cm-content');
  await content.click();
  await page.keyboard.press('End');
  await page.keyboard.type('\nSC-05 edit');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  // A completed write clears the dirty mark; Save stays as a disabled action
  // while the editor remains in Edit mode.
  await expect(page.locator('[title="Unsaved changes"]')).toHaveCount(0);
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(save).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a tracked Git row still rendered the Pierre diffs-container (no shared ' +
      'file view in the diff pane), App.tsx remained a Files CodeMirror, and the Markdown file kept ' +
      'Preview/Raw plus Edit/Save with a successful save',
  });
});
