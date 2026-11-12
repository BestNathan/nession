// #2751 — Files operation context, create-only writes and safe edits.
//
// The canonical fixture's FileOps is in-memory and mutable, so these flows can
// create, reveal and conflict without a network or the Agent host. The
// `window.fixtureFiles` control is the fixture's stand-in for a competing
// writer; it is not product surface.
import { expect, test, type Page } from '@playwright/test';
import {
  activateReference as activateFileReference,
  expectEditorAt as expectFileEditorAt,
  expectFilesSurface as expectFilesAt,
  openAppShell as openFileLinkApp,
  printReference as printFileReference,
  returnToTerminal as returnFromFiles,
  runLine as runFileLinkCommand,
  seedTerminalFiles,
} from '../../../e2e/acceptance/shared/terminal-file-links.cjs';

declare global {
  interface Window {
    fixtureFiles?: {
      reset: () => void;
      revisionOf: (path: string) => string;
      contentsOf: (path: string) => string | null;
      writeExternal: (path: string, content: string) => void;
      delayNextWrite: (milliseconds: number) => void;
      failNextWrite: (message?: string) => void;
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

test('Web: creation follows the captured selection/right-click target, create-only', async ({ page }) => {
  await openWebFiles(page);

  // Expand web -> src, then select the directory and create inside it.
  await clickTree(page, 'web');
  await clickTree(page, 'src');
  await expect(page.getByTestId('file-workspace')).toContainText('App.tsx');

  await page.getByLabel('New file').click();
  await expect(page.getByTestId('files-create-destination')).toHaveText('In web/src');
  await page.getByLabel('New file name').fill('e2e-created.txt');
  await expect(page.getByTestId('files-create-destination')).toContainText(
    'web/src/e2e-created.txt',
  );
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('e2e-created.txt', { exact: true })).toBeVisible();

  // Duplicate: create-only refuses and the form keeps the typed name.
  await page.getByLabel('New file').click();
  await page.getByLabel('New file name').fill('e2e-created.txt');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('files-create-error')).toContainText('already exists');
  await expect(page.getByLabel('New file name')).toHaveValue('e2e-created.txt');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // A selected file resolves to its parent.
  await clickTree(page, 'App.tsx');
  await page.getByLabel('New folder').click();
  await expect(page.getByTestId('files-create-destination')).toHaveText('In web/src');
  await page.getByLabel('New folder name').fill('e2e-folder');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('e2e-folder', { exact: true })).toBeVisible();

  // Right-click a directory: its own menu target wins over the selection.
  // The fixture's `web/src/app` directory is labelled `session-first`.
  await clickTree(page, 'session-first');
  const appDir = page
    .locator('[data-testid="file-workspace"] [role="tree"]')
    .getByText('session-first', { exact: true })
    .first();
  await appDir.click({ button: 'right' });
  await page.getByText('New file here').click();
  await expect(page.getByTestId('files-create-destination')).toHaveText('In web/src/app');
  await page.getByLabel('New file name').fill('inside.ts');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('inside.ts', { exact: true })).toBeVisible();
});

test('Web: switching from a dirty file is a guarded transition (#3171)', async ({ page }) => {
  await openWebFiles(page);
  await clickTree(page, 'web');
  await clickTree(page, 'src');
  await clickTree(page, 'index.css');
  await expect(page.getByText('web/src/index.css', { exact: true })).toBeVisible();

  // A clean file switches directly, without a decision.
  await clickTree(page, 'App.tsx');
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toBeVisible();
  await expect(page.getByTestId('files-web-unsaved-dialog')).toHaveCount(0);
  await clickTree(page, 'index.css');

  // Edit A, select B: one decision; Cancel keeps A, its draft and selection.
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('X');
  await clickTree(page, 'App.tsx');
  const dialog = page.getByTestId('files-web-unsaved-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('index.css');
  await expect(dialog).toContainText('App.tsx');
  await page.getByTestId('files-web-switch-cancel').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('web/src/index.css', { exact: true })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */X');

  // A repeated second target cannot replace the first pending decision.
  await clickTree(page, 'fixtures');
  const otherFile = page
    .locator('[data-testid="file-workspace"] [role="tree"]')
    .getByText('events.jsonl', { exact: true })
    .first();
  await clickTree(page, 'App.tsx');
  await expect(dialog).toBeVisible();
  await otherFile.evaluate((element) => (element as HTMLElement).click());
  await expect(dialog).toContainText('App.tsx');
  await page.getByTestId('files-web-switch-discard').click();
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();

  // A confirmed save is committed before the target opens.
  await clickTree(page, 'index.css');
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('Y');
  await clickTree(page, 'App.tsx');
  await page.getByTestId('files-web-switch-save').click();
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toBeVisible();
  await clickTree(page, 'index.css');
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */Y');
});

test('Web: a pending or failed save cannot silently replace the dirty file (#3171)', async ({ page }) => {
  await openWebFiles(page);
  await clickTree(page, 'web');
  await clickTree(page, 'src');
  await clickTree(page, 'index.css');
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('Z');

  // A save already in flight owns the transition: the guard waits, then opens
  // the target only because that save completed with the committed edit.
  await page.evaluate(() => window.fixtureFiles?.delayNextWrite(800));
  await page.getByRole('button', { name: 'Save' }).click();
  await clickTree(page, 'App.tsx');
  await expect(page.getByTestId('files-web-unsaved-dialog')).toBeVisible();
  await expect(page.getByTestId('files-web-switch-save')).toHaveText('Saving…');
  await expect(page.getByTestId('files-web-switch-discard')).toBeDisabled();
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toBeVisible({
    timeout: 5000,
  });
  await clickTree(page, 'index.css');
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */Z');

  // A failed save leaves A mounted, keeps the draft and does not open B.
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('Q');
  await page.evaluate(() => window.fixtureFiles?.failNextWrite('fixture write unavailable'));
  await clickTree(page, 'App.tsx');
  await page.getByTestId('files-web-switch-save').click();
  await expect(page.getByTestId('files-web-switch-error')).toContainText('could not be saved');
  await expect(page.getByText('web/src/index.css', { exact: true })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */ZQ');
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toHaveCount(0);

  // The explicit discard after that failure still opens the target.
  await page.getByTestId('files-web-switch-discard').click();
  await expect(page.getByText('web/src/App.tsx', { exact: true })).toBeVisible();
});

test('Web: a save against a changed file offers reload/overwrite', async ({ page }) => {
  await openWebFiles(page);
  await clickTree(page, 'web');
  await clickTree(page, 'src');
  await clickTree(page, 'index.css');

  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('X');

  await page.evaluate(() => {
    window.fixtureFiles?.writeExternal('web/src/index.css', 'external change');
  });
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByTestId('file-conflict-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Reload file' }).click();
  await expect(page.getByTestId('file-conflict-dialog')).toBeHidden();
  await expect(page.locator('.cm-content')).toContainText('external change');
});

test('Web: edits typed during a pending save stay dirty after it completes (#3322)', async ({ page }) => {
  await openWebFiles(page);
  await clickTree(page, 'web');
  await clickTree(page, 'src');
  await clickTree(page, 'index.css');
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('B1');

  // Commit B1 while holding the response; the editor moves on to C1.
  await page.evaluate(() => window.fixtureFiles?.delayNextWrite(800));
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('C1');

  // B1's successful write must not mark the newer C1 as saved.
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled({ timeout: 5000 });
  await expect(page.getByTitle('Unsaved changes')).toBeVisible();
  // Only the submitted snapshot reached the fixture; C1 is still local.
  const committed = await page.evaluate(() => window.fixtureFiles?.contentsOf('web/src/index.css'));
  expect(committed).toContain('B1');
  expect(committed).not.toContain('C1');

  // The next save persists C1 and only then clears dirty.
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTitle('Unsaved changes')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(
    await page.evaluate(() => window.fixtureFiles?.contentsOf('web/src/index.css')),
  ).toContain('B1C1');

  // Re-reading the file shows both persisted writes, not a discarded draft.
  await clickTree(page, 'App.tsx');
  await clickTree(page, 'index.css');
  await expect(page.locator('.cm-content')).toContainText('B1C1');
});

test('App: create in the pushed folder, read-first viewer, unsaved guard', async ({ page }) => {
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();

  await page.getByTestId('file-row-web').click();
  await page.getByTestId('file-row-web/src').click();
  await expect(page.getByTestId('files-app-list')).toContainText('App.tsx');

  await page.getByLabel('Folder actions').click();
  await expect(page.getByTestId('files-app-folder-sheet')).toBeVisible();
  await page.getByRole('button', { name: 'New file' }).click();
  await expect(page.getByTestId('app-files-create-destination')).toHaveText(
    'In web/src',
  );
  await page.getByLabel('New file name').fill('app-e2e.txt');
  await page.getByRole('button', { name: 'Create' }).click();

  // The created file is pushed read-first: Edit is offered, Save is not shown
  // until the user explicitly edits.
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('draft');

  // Leaving the pushed detail with unsaved edits asks first.
  await page.getByTestId('app-page-back').click();
  await expect(page.getByRole('alertdialog')).toContainText('Unsaved changes');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
});

test('Web: selected row surface, disclosure caret and collapse after opening a file', async ({ page }) => {
  await openWebFiles(page);
  await clickTree(page, 'web');
  await clickTree(page, 'src');
  await clickTree(page, 'index.css');
  await expect(page.locator('.cm-content')).toContainText('/* fixture css */');

  const tree = page.locator('[data-testid="file-workspace"] [role="tree"]');
  const row = (name: string) =>
    tree
      .locator('[role="treeitem"]', { hasText: new RegExp('^\\s*' + name + '\\s*$') })
      .first();
  const trigger = (name: string) =>
    row(name).locator('[data-slot="context-menu-trigger"]');

  // Selection is a visible surface, the same row fill used by Session rows.
  // The unselected sibling is the control, so this cannot pass on a shared
  // stylesheet default.
  const selectedBackground = await trigger('index.css').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const unselectedBackground = await trigger('App.tsx').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(selectedBackground).not.toBe(unselectedBackground);
  expect(selectedBackground).not.toBe('rgba(0, 0, 0, 0)');
  await expect(row('index.css')).toHaveAttribute('aria-selected', 'true');

  // Directories carry the disclosure control; files keep the same indent.
  await expect(row('src').getByTestId('explorer-caret')).toHaveAttribute(
    'aria-label',
    'Collapse folder',
  );
  await expect(row('App.tsx').getByTestId('explorer-caret')).toHaveCount(0);

  // Collapsing the folder that contains the open file must survive a tree
  // reload; the file's path is not a standing reveal request.
  await row('src').getByTestId('explorer-caret').click();
  await expect(tree.getByText('index.css', { exact: true })).toHaveCount(0);
  await expect(row('src')).toHaveAttribute('aria-expanded', 'false');
  await page.getByLabel('Refresh').click();
  await expect(tree.getByText('index.css', { exact: true })).toHaveCount(0);
  await expect(row('src')).toHaveAttribute('aria-expanded', 'false');

  // Re-expanding through the caret does not steal the file's selection.
  await row('src').getByTestId('explorer-caret').click();
  await expect(tree.getByText('index.css', { exact: true })).toBeVisible();
  await expect(row('index.css')).toHaveAttribute('aria-selected', 'true');
});

// #3187: the App's terminal → Files handoff opens the pushed viewer at the
// referenced line through the same Session's FileOps/CWD.
test('App: a Terminal file reference opens the pushed Files viewer at its line', async ({ page }) => {
  test.skip(!process.env.CI, 'real stack available in CI only');
  await page.setViewportSize({ width: 390, height: 844 });
  const runtime = { server_port: 19090, home: '/tmp/nession-e2e' };
  seedTerminalFiles(runtime.home);
  await openFileLinkApp(page, expect, runtime, 'e2e-3187-app');
  await runFileLinkCommand(page, expect, 'cd src/deep');
  await printFileReference(page, expect, 'target.py:7:3');
  await activateFileReference(page, 'target.py:7:3');
  await expectFilesAt(page, expect, 'app');
  await expectFileEditorAt(page, expect, {
    count: 1, line: 7, column: 3, activeLineText: 'target-line-7',
  });
  await returnFromFiles(page, expect, 'app');
  await expect(page.getByTestId('terminal-surface')).toBeVisible();
});
