// #3743 SC-02: a conflict reload is a read → commit transaction. While the
// replacement read is held, the draft stays dirty and the switch guard still
// asks; dirty is cleared only after the committed replacement. A delayed
// failed or superseded read cannot clear a successor's newer edit or bypass
// its navigation protection.
import { expect, test, type Page } from '@playwright/test';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

declare global {
  interface Window {
    fixtureFiles?: {
      holdNextRead: () => void;
      releaseHeldRead: () => void;
      failHeldRead: (message?: string) => void;
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

test('SC-02: dirty survives until the replacement commits; stale reads cannot clear it', async ({ page }) => {
  test.setTimeout(110_000);
  verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWebFiles(page);
  await clickTree(page, 'web');
  await clickTree(page, 'src');
  await clickTree(page, 'index.css');
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */');
  const dialog = page.getByTestId('files-web-unsaved-dialog');

  // -- A held replacement read does not clear the guard before it commits. --
  await editWith(page, '-FIRST');
  await page.evaluate((path) => window.fixtureFiles?.writeExternal(path, 'external first'), FILE);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('file-conflict-dialog')).toBeVisible();
  await page.evaluate(() => window.fixtureFiles?.holdNextRead());
  await page.getByRole('button', { name: 'Reload file' }).click();
  await expect(page.getByTestId('file-conflict-dialog')).toBeHidden();

  // Read in flight: still dirty, and leaving is still a guarded decision.
  await expect(page.getByTitle('Unsaved changes')).toBeVisible();
  await clickTree(page, 'App.tsx');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('index.css');
  await page.getByTestId('files-web-switch-cancel').click();
  await expect(dialog).toBeHidden();

  // The commit replaces content and baseline together; only now is it clean.
  await page.evaluate(() => window.fixtureFiles?.releaseHeldRead());
  await expect(page.locator('.cm-content')).toContainText('external first');
  await expect(page.locator('.cm-content')).not.toContainText('-FIRST');
  await expect(page.getByTitle('Unsaved changes')).toHaveCount(0);

  // The committed replacement also replaced the revision: a fresh guarded save
  // no longer conflicts with the competing writer.
  await editWith(page, '-AFTER');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved index.css')).toBeVisible();
  await expect(page.getByTitle('Unsaved changes')).toHaveCount(0);
  await clickTree(page, 'App.tsx');
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);

  // -- A delayed failed reload retains the draft and its guard. --
  await clickTree(page, 'index.css');
  await expect(page.locator('.cm-content')).toContainText('external first-AFTER');
  await editWith(page, '-SECOND');
  await page.evaluate((path) => window.fixtureFiles?.writeExternal(path, 'external second'), FILE);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('file-conflict-dialog')).toBeVisible();
  await page.evaluate(() => window.fixtureFiles?.holdNextRead());
  await page.getByRole('button', { name: 'Reload file' }).click();
  await expect(page.getByTestId('file-conflict-dialog')).toBeHidden();

  // The held read is superseded by a switch; the guard asks first.
  await clickTree(page, 'App.tsx');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('files-web-switch-cancel')).toBeEnabled();
  await page.getByTestId('files-web-switch-cancel').click();
  await expect(dialog).toBeHidden();

  // The delayed read fails: the draft stays dirty and still guards leaving.
  await page.evaluate(() => window.fixtureFiles?.failHeldRead('stale reload failed'));
  await expect(page.getByText('stale reload failed')).toBeVisible();
  await expect(page.getByTitle('Unsaved changes')).toBeVisible();
  await clickTree(page, 'App.tsx');
  await expect(dialog).toBeVisible();
  await page.getByTestId('files-web-switch-cancel').click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('.cm-content')).toContainText('-SECOND');
  await expect(page.locator('.cm-content')).not.toContainText('external second');
  await expect(page.getByTitle('Unsaved changes')).toBeVisible();

  // -- A read superseded by leaving cannot clear the successor's edit. --
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('file-conflict-dialog')).toBeVisible();
  await page.evaluate(() => window.fixtureFiles?.holdNextRead());
  await page.getByRole('button', { name: 'Reload file' }).click();
  await expect(page.getByTestId('file-conflict-dialog')).toBeHidden();

  // Discard leaves the file while its replacement read is still held, so the
  // old flight settles into a successor that now has its own draft.
  await clickTree(page, 'App.tsx');
  await expect(dialog).toBeVisible();
  await page.getByTestId('files-web-switch-discard').click();
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toBeVisible();
  await editWith(page, '-APP-DRAFT');
  await expect(page.getByTitle('Unsaved changes')).toBeVisible();

  // The superseded read fails late. It must not leak an error into App.tsx or
  // clear the newer draft's dirty report.
  await page.evaluate(() => window.fixtureFiles?.failHeldRead('superseded reload failed'));
  await expect(page.getByText('superseded reload failed')).toHaveCount(0);
  await expect(page.getByTitle('Unsaved changes')).toBeVisible();
  await clickTree(page, 'index.css');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('App.tsx');
  await page.getByTestId('files-web-switch-cancel').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.cm-content')).toContainText('-APP-DRAFT');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'fixture whole-file reads held/deferred: during the in-flight conflict Reload the ' +
      'Unsaved changes report stayed set and switching files still raised the guard; after ' +
      'release the replacement content replaced the draft and only then did the dot and the ' +
      'guard clear; a failed held reload kept the draft and re-armed the guard; a read ' +
      'superseded by Discard+leave could not clear the successor App.tsx draft, which still ' +
      'prompted on the next switch',
  });
});
