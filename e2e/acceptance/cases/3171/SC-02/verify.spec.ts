// #3171 SC-02: a save that is pending or fails cannot silently replace A.
// A successful in-flight save may proceed to B with the committed edit; a
// failed or conflicting write keeps A and its draft. Repeated B/C requests
// cannot bypass the guard or open a different target than the one shown.
import { expect, test, type Page } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

declare global {
  interface Window {
    fixtureFiles?: {
      delayNextWrite: (milliseconds: number) => void;
      failNextWrite: (message?: string) => void;
      writeExternal: (path: string, content: string) => void;
    };
  }
}

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

test('SC-02: pending, failed and conflicting saves cannot silently replace A', async ({ page }) => {
  test.setTimeout(110_000);
  verifiedRuntime('SC-02');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWebFiles(page);
  await clickTree(page, 'web');
  await clickTree(page, 'src');
  await clickTree(page, 'fixtures');
  await clickTree(page, 'index.css');

  // A save already in flight owns the transition; the guard waits for it and
  // opens B only because the commit succeeded with A's edit.
  await editWith(page, 'SC02-PENDING');
  await page.evaluate(() => window.fixtureFiles?.delayNextWrite(800));
  await page.getByRole('button', { name: 'Save' }).click();
  await clickTree(page, 'App.tsx');
  const dialog = page.getByTestId('files-web-unsaved-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('files-web-switch-save')).toHaveText('Saving…');
  await expect(page.getByTestId('files-web-switch-discard')).toBeDisabled();
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toBeVisible({
    timeout: 5000,
  });
  await clickTree(page, 'index.css');
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */SC02-PENDING');

  // A failed save keeps A mounted, preserves the draft and never opens B.
  await editWith(page, '-FAIL');
  await page.evaluate(() => window.fixtureFiles?.failNextWrite('fixture write unavailable'));
  await clickTree(page, 'App.tsx');
  await page.getByTestId('files-web-switch-save').click();
  await expect(page.getByTestId('files-web-switch-error')).toContainText('could not be saved');
  await expect(page.getByText('web/src/index.css', { exact: true })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */SC02-PENDING-FAIL');
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toHaveCount(0);

  // Repeated B/C requests cannot replace the target shown in the guard.
  await page.getByTestId('files-web-switch-discard').click();
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toBeVisible();
  await clickTree(page, 'index.css');
  await editWith(page, '-REPEAT');
  await clickTree(page, 'App.tsx');
  await expect(dialog).toBeVisible();
  await page
    .locator('[data-testid="file-workspace"] [role="tree"]')
    .getByText('events.jsonl', { exact: true })
    .first()
    .evaluate((element) => (element as HTMLElement).click());
  await expect(dialog).toContainText('App.tsx');
  await expect(dialog).not.toContainText('events.jsonl');
  await page.getByTestId('files-web-switch-discard').click();
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toBeVisible();
  await expect(page.getByText('fixtures/events.jsonl', { exact: true })).toHaveCount(0);

  // The explicit discard did not persist the discarded draft.
  await clickTree(page, 'index.css');
  await expect(page.locator('.cm-content')).not.toContainText('SC02-PENDING-FAIL-REPEAT');

  // A conflict is a save failure: the viewer's own conflict decision replaces
  // the navigation decision, and B does not open.
  await editWith(page, '-CONFLICT');
  await page.evaluate(() => {
    window.fixtureFiles?.writeExternal('web/src/index.css', 'external writer');
  });
  await clickTree(page, 'App.tsx');
  await page.getByTestId('files-web-switch-save').click();
  await expect(page.getByTestId('file-conflict-dialog')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('web/src/index.css', { exact: true })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('SC02-PENDING-CONFLICT');
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByTestId('file-conflict-dialog')).toBeHidden();
});
