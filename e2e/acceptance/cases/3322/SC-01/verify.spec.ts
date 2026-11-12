// #3322 SC-01: a successful save commits the snapshot it submitted. Editing
// while that write is pending must stay visible and dirty; a second save
// persists the newer content, and dirty clears only when the editor matches
// the snapshot a save committed.
import { expect, test, type Page } from '@playwright/test';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

declare global {
  interface Window {
    fixtureFiles?: {
      delayNextWrite: (milliseconds: number) => void;
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

test('SC-01: edits made during a pending save stay dirty until a matching save commits them', async ({ page }) => {
  test.setTimeout(110_000);
  verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWebFiles(page);
  await clickTree(page, 'web');
  await clickTree(page, 'src');
  await clickTree(page, 'index.css');

  // B is the snapshot the save submits; C is typed while that write is held.
  await editWith(page, 'SC01-B');
  await page.evaluate(() => window.fixtureFiles?.delayNextWrite(900));
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('SC01-C');

  // The delayed write of B succeeds. The editor still holds B+C, so Save stays
  // offered and the dirty marker stays; only the submitted snapshot persisted.
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByTitle('Unsaved changes')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('SC01-BSC01-C');
  const committedB = await persisted(page);
  expect(committedB).toContain('SC01-B');
  expect(committedB).not.toContain('SC01-C');

  // A second save persists the current content and clears dirty only then.
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTitle('Unsaved changes')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(await persisted(page)).toContain('SC01-BSC01-C');
  await expect(page.getByTestId('file-conflict-dialog')).toHaveCount(0);

  // Leaving is unguarded now, and re-opening reads the committed content.
  await clickTree(page, 'App.tsx');
  await expect(page.getByTestId('files-web-unsaved-dialog')).toHaveCount(0);
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toBeVisible();
  await clickTree(page, 'index.css');
  await expect(page.locator('.cm-content')).toContainText('SC01-BSC01-C');
});
