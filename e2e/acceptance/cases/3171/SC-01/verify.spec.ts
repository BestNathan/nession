// #3171 SC-01: a dirty Web file is a guarded navigation decision. A clean file
// switches directly; a dirty A presents exactly one decision. Cancel keeps A,
// its exact draft and its tree selection; Discard opens B and A's persisted
// content is unchanged.
import { expect, test, type Page } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

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

async function editWith(page: Page, marker: string): Promise<void> {
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type(marker);
}

test('SC-01: Cancel keeps A and its draft; Discard opens B', async ({ page }) => {
  test.setTimeout(110_000);
  verifiedRuntime('SC-01');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWebFiles(page);
  await clickTree(page, 'web');
  await clickTree(page, 'src');

  // A clean A switches directly, with no navigation decision.
  await clickTree(page, 'index.css');
  await expect(page.getByText('web/src/index.css', { exact: true })).toBeVisible();
  await clickTree(page, 'App.tsx');
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toBeVisible();
  await expect(page.getByTestId('files-web-unsaved-dialog')).toHaveCount(0);

  // Dirty A → B presents one decision; Cancel preserves A exactly.
  await clickTree(page, 'index.css');
  await editWith(page, 'SC01-DRAFT');
  await clickTree(page, 'App.tsx');
  const dialog = page.getByTestId('files-web-unsaved-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('[role="alertdialog"]')).toHaveCount(1);
  await expect(dialog).toContainText('Unsaved changes');
  await expect(dialog).toContainText('index.css');
  await expect(dialog).toContainText('App.tsx');
  await page.getByTestId('files-web-switch-cancel').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('web/src/index.css', { exact: true })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */SC01-DRAFT');
  const tree = page.locator('[data-testid="file-workspace"] [role="tree"]');
  await expect(
    tree.locator('[role="treeitem"]', { hasText: /^\s*index\.css\s*$/ }).first(),
  ).toHaveAttribute('aria-selected', 'true');

  // A repeated request still has one decision; Discard opens B.
  await clickTree(page, 'App.tsx');
  await expect(dialog).toBeVisible();
  await page.getByTestId('files-web-switch-discard').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toBeVisible();
  await expect(page.getByTestId('files-web-unsaved-dialog')).toHaveCount(0);

  // A's discarded draft is not persisted.
  await clickTree(page, 'index.css');
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */');
  await expect(page.locator('.cm-content')).not.toContainText('SC01-DRAFT');
});
