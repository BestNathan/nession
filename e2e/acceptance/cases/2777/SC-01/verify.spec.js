'use strict';
// #2777 SC-01: selection is a visible surface, not only an aria flag; the
// disclosure control does not move it, and files have no disclosure control.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-01: selected rows paint one surface and disclosure leaves selection alone', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-01');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=files');
  await expect(page.getByTestId('file-workspace')).toBeVisible();

  const tree = page.locator('[data-testid="file-workspace"] [role="tree"]');
  const row = (name) =>
    tree
      .locator('[role="treeitem"]', { hasText: new RegExp('^\\s*' + name + '\\s*$') })
      .first();
  const trigger = (name) => row(name).locator('[data-slot="context-menu-trigger"]');
  const background = (name) =>
    trigger(name).evaluate((element) => getComputedStyle(element).backgroundColor);

  // Activating a directory selects it and shows one surface. The sibling is
  // the unselected control, so a shared stylesheet default cannot pass this.
  await row('web').getByTestId('explorer-caret').click();
  await expect(tree.getByText('src', { exact: true })).toBeVisible();
  await row('docs').click();
  await expect(row('docs')).toHaveAttribute('aria-selected', 'true');
  await expect(trigger('docs')).toHaveAttribute('data-selected', 'true');
  const selected = await background('docs');
  const unselected = await background('web');
  expect(selected).not.toBe(unselected);
  expect(selected).not.toBe('rgba(0, 0, 0, 0)');
  await expect(trigger('docs')).toHaveClass(/(^|\s)bg-muted(\s|$)/);
  await expect(trigger('web')).not.toHaveClass(/(^|\s)bg-muted(\s|$)/);

  // Selection moves to the activated file; file rows have no caret.
  await row('src').getByTestId('explorer-caret').click();
  await expect(tree.getByText('App.tsx', { exact: true })).toBeVisible();
  await row('App.tsx').click();
  await expect(row('App.tsx')).toHaveAttribute('aria-selected', 'true');
  await expect(row('docs')).toHaveAttribute('aria-selected', 'false');
  await expect(trigger('App.tsx')).toHaveClass(/(^|\s)bg-muted(\s|$)/);
  await expect(row('App.tsx').getByTestId('explorer-caret')).toHaveCount(0);

  // Collapsing a folder through its caret does not steal the file's selection;
  // re-expanding restores the selected surface without changing the active file.
  await row('web').getByTestId('explorer-caret').click();
  await expect(row('web')).toHaveAttribute('aria-expanded', 'false');
  await expect(tree.getByText('App.tsx', { exact: true })).toHaveCount(0);
  await row('web').getByTestId('explorer-caret').click();
  await expect(tree.getByText('App.tsx', { exact: true })).toBeVisible();
  await expect(row('App.tsx')).toHaveAttribute('aria-selected', 'true');
  await expect(trigger('App.tsx')).toHaveClass(/(^|\s)bg-muted(\s|$)/);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': activating docs painted a bg-muted surface distinct from the ' +
      'unselected web row; activating App.tsx moved that surface and the file row rendered no ' +
      'disclosure control; collapsing web through its caret hid the selected file without ' +
      'clearing its selection, and re-expanding restored the selected surface',
  });
});
