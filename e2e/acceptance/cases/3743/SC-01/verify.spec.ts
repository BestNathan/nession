// #3743 SC-01: a failed conflict reload is not a discard. Reload's replacement
// read is rejected deterministically; the draft stays dirty, the Web switch
// guard still asks Save/Discard/Cancel, and Retry or Keep editing cannot
// silently lose the draft.
import { expect, test, type Page } from '@playwright/test';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

declare global {
  interface Window {
    fixtureFiles?: {
      failNextRead: (message?: string) => void;
      writeExternal: (path: string, content: string) => void;
    };
  }
}

const FILE = 'web/src/index.css';

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
  // A viewer that already replaced its buffer stays in edit mode, so the
  // toolbar may show View instead of Edit.
  const edit = page.getByRole('button', { name: 'Edit' });
  await expect(edit.or(page.getByRole('button', { name: 'View' }))).toBeVisible();
  if (await edit.isVisible()) { await edit.click(); }
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type(marker);
}

test('SC-01: a failed conflict reload keeps the draft dirty and guarded', async ({ page }) => {
  test.setTimeout(110_000);
  verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWebFiles(page);
  await clickTree(page, 'web');
  await clickTree(page, 'src');
  await clickTree(page, 'index.css');
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */');

  // A competing writer invalidates the revision the viewer loaded.
  await editWith(page, '-DRAFT');
  await page.evaluate((path) => window.fixtureFiles?.writeExternal(path, 'external SC-01'), FILE);
  await page.getByRole('button', { name: 'Save' }).click();
  const conflict = page.getByTestId('file-conflict-dialog');
  await expect(conflict).toBeVisible();

  // Reload's replacement read rejects deterministically.
  await page.evaluate(() => window.fixtureFiles?.failNextRead('fixture read unavailable'));
  await page.getByRole('button', { name: 'Reload file' }).click();
  await expect(conflict).toBeHidden();
  await expect(page.getByText('fixture read unavailable')).toBeVisible();

  // The draft is still dirty; the toolbar dot is the viewer's dirty report.
  await expect(page.getByTitle('Unsaved changes')).toBeVisible();

  // Switching files still asks for the full save/discard/cancel decision.
  await clickTree(page, 'App.tsx');
  const dialog = page.getByTestId('files-web-unsaved-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('index.css');
  await expect(dialog).toContainText('App.tsx');
  await expect(page.getByTestId('files-web-switch-save')).toBeEnabled();
  await expect(page.getByTestId('files-web-switch-discard')).toBeEnabled();
  await expect(page.getByTestId('files-web-switch-cancel')).toBeEnabled();
  await page.getByTestId('files-web-switch-cancel').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('web/src/index.css', { exact: true })).toBeVisible();

  // Retry is another replacement attempt; failing again keeps the draft.
  await page.evaluate(() => window.fixtureFiles?.failNextRead('fixture read unavailable again'));
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('fixture read unavailable again')).toBeVisible();
  await expect(page.getByTitle('Unsaved changes')).toBeVisible();

  // Keep editing returns to the retained draft, not the external content.
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */-DRAFT');
  await expect(page.locator('.cm-content')).not.toContainText('external SC-01');
  await expect(page.getByTitle('Unsaved changes')).toBeVisible();

  // The retained draft is still what leaving must guard.
  await clickTree(page, 'App.tsx');
  await expect(dialog).toBeVisible();
  await page.getByTestId('files-web-switch-cancel').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.cm-content')).toContainText('-DRAFT');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'fixture readFile rejected after a revision-conflict Reload: the error state showed, ' +
      'the Unsaved changes report stayed set, switching files still raised the Save/Discard/' +
      'Cancel dialog, a second failed Retry kept the draft, and Keep editing restored the ' +
      'exact "-DRAFT" buffer instead of the competing external content',
  });
});
