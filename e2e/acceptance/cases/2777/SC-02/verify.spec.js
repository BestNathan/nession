'use strict';
// #2777 SC-02: opening a file is not a standing reveal request. Collapsing its
// folder keeps it collapsed across a refresh, and the caret restores the
// selected file without changing the open document.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-02: a folder stays collapsed after its file was opened, even across a refresh', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=files');
  await expect(page.getByTestId('file-workspace')).toBeVisible();

  const tree = page.locator('[data-testid="file-workspace"] [role="tree"]');
  const row = (name) =>
    tree
      .locator('[role="treeitem"]', { hasText: new RegExp('^\\s*' + name + '\\s*$') })
      .first();

  await row('web').getByTestId('explorer-caret').click();
  await row('src').getByTestId('explorer-caret').click();
  await row('index.css').click();
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */');

  // Caret collapse: the reveal effect must not re-open the folder.
  await row('src').getByTestId('explorer-caret').click();
  await expect(row('src')).toHaveAttribute('aria-expanded', 'false');
  await expect(tree.getByText('index.css', { exact: true })).toHaveCount(0);
  await page.getByLabel('Refresh').click();
  await expect(row('src')).toHaveAttribute('aria-expanded', 'false');
  await expect(tree.getByText('index.css', { exact: true })).toHaveCount(0);

  // Re-expanding shows the still-selected file and keeps the open document.
  await row('src').getByTestId('explorer-caret').click();
  await expect(tree.getByText('index.css', { exact: true })).toBeVisible();
  await expect(row('index.css')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */');

  // The row path also collapses, survives a refresh, and leaves the file
  // closed only as a row (the document stays open).
  await row('src').click();
  await expect(row('src')).toHaveAttribute('aria-expanded', 'false');
  await expect(tree.getByText('index.css', { exact: true })).toHaveCount(0);
  await page.getByLabel('Refresh').click();
  await expect(row('src')).toHaveAttribute('aria-expanded', 'false');
  await expect(tree.getByText('index.css', { exact: true })).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': after opening web/src/index.css, collapsing src through its ' +
      'caret hid the file and a Refresh did not re-expand it; re-expanding restored the ' +
      'aria-selected file row and the same open document; collapsing src through its row also ' +
      'survived a refresh while the document remained open',
  });
});
