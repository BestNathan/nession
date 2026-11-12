// #3322 SC-02: a save that succeeds with an older snapshot, or fails, must
// not suppress the unsaved-changes guard for edits made while it was pending.
// Leaving the file still asks; Cancel keeps the draft; a discarded draft never
// reaches the fixture.
import { expect, test, type Page } from '@playwright/test';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

declare global {
  interface Window {
    fixtureFiles?: {
      delayNextWrite: (milliseconds: number) => void;
      failNextWrite: (message?: string) => void;
      contentsOf: (path: string) => string | null;
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
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type(marker);
}

async function persisted(page: Page): Promise<string | null> {
  return page.evaluate((path) => window.fixtureFiles?.contentsOf(path) ?? null, FILE);
}

test('SC-02: an older pending save never suppresses the Web guard for newer edits', async ({ page }) => {
  test.setTimeout(110_000);
  verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWebFiles(page);
  await clickTree(page, 'web');
  await clickTree(page, 'src');
  await clickTree(page, 'index.css');

  // Save B while holding the response, then continue editing to C.
  await editWith(page, 'SC02-B');
  await page.evaluate(() => window.fixtureFiles?.delayNextWrite(900));
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('SC02-C');
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByTitle('Unsaved changes')).toBeVisible();
  const committedB = await persisted(page);
  expect(committedB).toContain('SC02-B');
  expect(committedB).not.toContain('SC02-C');

  // Leaving still asks, because C was not part of the committed snapshot.
  await clickTree(page, 'App.tsx');
  const dialog = page.getByTestId('files-web-unsaved-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('index.css');
  await expect(dialog).toContainText('App.tsx');

  // Cancel keeps A mounted with the full draft.
  await page.getByTestId('files-web-switch-cancel').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('web/src/index.css', { exact: true })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('SC02-BSC02-C');

  // A rejected write keeps the draft and its dirty report; the guard asks again.
  await page.evaluate(() => window.fixtureFiles?.failNextWrite('fixture write unavailable'));
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled({ timeout: 5_000 });
  await expect(page.getByTitle('Unsaved changes')).toBeVisible();
  expect(await persisted(page)).toContain('SC02-B');
  expect(await persisted(page)).not.toContain('SC02-C');
  await clickTree(page, 'App.tsx');
  await expect(dialog).toBeVisible();

  // Discard opens B; the newer draft never reached the fixture.
  await page.getByTestId('files-web-switch-discard').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toBeVisible();
  expect(await persisted(page)).toContain('SC02-B');
  expect(await persisted(page)).not.toContain('SC02-C');
});

test('SC-02: the App Back guard survives an older pending save', async ({ page }) => {
  test.setTimeout(110_000);
  verifiedRuntime('SC-02');
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  await page.getByTestId('file-row-web').click();
  await page.getByTestId('file-row-web/src').click();
  await page.getByTestId('file-row-web/src/index.css').click();

  await editWith(page, 'APP-B');
  await page.evaluate(() => window.fixtureFiles?.delayNextWrite(900));
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('APP-C');
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByTitle('Unsaved changes')).toBeVisible();
  const committedB = await persisted(page);
  expect(committedB).toContain('APP-B');
  expect(committedB).not.toContain('APP-C');

  // Back owns leaving the pushed viewer; the newer edit keeps it guarded.
  await page.getByTestId('app-page-back').click();
  const backDialog = page.getByRole('alertdialog');
  await expect(backDialog).toContainText('Unsaved changes');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(backDialog).toBeHidden();
  await expect(page.locator('.cm-content')).toContainText('APP-BAPP-C');
});
