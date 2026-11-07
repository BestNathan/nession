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
  await page.goto('/#/fixture/workspace?capability=files');
  await expect(page.getByTestId('file-workspace')).toBeVisible();
  await page.getByTestId('file-row-web').click();
  await page.getByTestId('file-row-web/src').click();
  await page.getByTestId('file-row-web/src/App.tsx').click();
  const filesEditor = page.getByTestId('codemirror-editor');
  await expect(filesEditor).toBeVisible();
  await expect(page.getByTestId('file-view-unavailable')).toHaveCount(0);

  await page.getByTestId('file-row-docs').click();
  await page.getByTestId('file-row-docs/design').click();
  await page.getByTestId('file-row-docs/design/visual-language.md').click();
  await expect(page.getByRole('button', { name: 'Preview', pressed: true })).toBeVisible();
  await page.getByRole('button', { name: 'Raw', pressed: false }).click();
  await expect(page.getByTestId('codemirror-editor')).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  const content = page.locator('.cm-content');
  await content.click();
  await page.keyboard.press('End');
  await page.keyboard.type('\nSC-05 edit');
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a tracked Git row still rendered the Pierre diffs-container (no shared ' +
      'file view in the diff pane), App.tsx remained a Files CodeMirror, and the Markdown file kept ' +
      'Preview/Raw plus Edit/Save with a successful save',
  });
});
