'use strict';
// #2777 SC-03: the disclosure caret is a real, labelled control that toggles
// expansion only — never selection, the browse directory or the open file.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-03: disclosure caret toggles expansion without selecting or navigating', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-03');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=files');
  await expect(page.getByTestId('file-workspace')).toBeVisible();

  const tree = page.locator('[data-testid="file-workspace"] [role="tree"]');
  const row = (name) =>
    tree
      .locator('[role="treeitem"]', { hasText: new RegExp('^\\s*' + name + '\\s*$') })
      .first();
  const caret = (name) => row(name).getByTestId('explorer-caret');

  // From an unselected tree, expanding through the caret must leave the row
  // unselected and the browse directory at the workspace root.
  await expect(caret('web')).toHaveAttribute('aria-label', 'Expand folder');
  await caret('web').click();
  await expect(tree.getByText('src', { exact: true })).toBeVisible();
  await expect(row('web')).toHaveAttribute('aria-expanded', 'true');
  await expect(row('web')).toHaveAttribute('aria-selected', 'false');
  await expect(caret('web')).toHaveAttribute('aria-label', 'Collapse folder');
  await expect(caret('web')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Select a file to view it.')).toBeVisible();

  await page.getByLabel('New file').click();
  await expect(page.getByTestId('files-create-destination')).toHaveText('In Workspace root');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(row('web')).toHaveAttribute('aria-selected', 'false');

  // With a file open, collapsing and re-expanding through the caret keeps the
  // same open document and the file's selection.
  await caret('src').click();
  await row('index.css').click();
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */');
  await expect(row('index.css')).toHaveAttribute('aria-selected', 'true');
  await caret('src').click();
  await expect(row('src')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */');
  await expect(row('index.css')).toHaveCount(0);
  await caret('src').click();
  await expect(row('index.css')).toBeVisible();
  await expect(row('index.css')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */');

  // Files carry no disclosure control.
  await expect(row('index.css').getByTestId('explorer-caret')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the web caret was labelled Expand folder and expanded without ' +
      'selecting the row or moving the create destination off the workspace root; with ' +
      'index.css open, collapsing and re-expanding src through its caret kept the same open ' +
      'document and the file selected; the file row rendered no caret',
  });
});
