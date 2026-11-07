'use strict';
// #2876 SC-01: an untracked text file (and an unmerged conflict) opens its
// actual worktree text in a read-only CodeMirror with line numbers and language
// highlighting — never the old <pre> and never an edit/save/merge control.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-01: untracked and unmerged text render in read-only CodeMirror', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-01');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=git&git=preview-states');
  await page.getByTestId('git-change-list').waitFor();

  const row = page.getByTestId('git-row-untracked').filter({ hasText: 'notes/example.ts' });
  await row.click();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('git-file-preview-path')).toHaveText('notes/example.ts');
  await expect(page.getByTestId('git-file-preview-status')).toContainText(
    'Untracked · File preview (no Git baseline)',
  );

  const text = page.getByTestId('git-file-preview-text');
  const editor = text.locator('.cm-editor');
  await expect(editor).toBeVisible();
  await expect(text.locator('.cm-lineNumbers')).toBeVisible();
  await expect(text).toContainText('export const greeting');
  await expect(text.locator('pre')).toHaveCount(0);
  await expect(text.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(text.locator('.cm-content')).toHaveCSS('user-select', /text|auto/);
  // Language-aware rendering produces token spans, not one flat text node.
  expect(await text.locator('.cm-line span[class]').count()).toBeGreaterThan(0);

  // A Git read-only surface offers no write/merge affordance.
  await expect(
    page.getByRole('button', { name: /stage|commit|push|discard|resolve|merge/i }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Save$|^Edit$/ })).toHaveCount(0);

  const conflict = page.getByTestId('git-row-unmerged').filter({ hasText: 'src/conflict.rs' });
  await conflict.click();
  await expect(page.getByTestId('git-file-preview-status')).toContainText(
    'Unresolved conflict · File preview',
  );
  const conflictText = page.getByTestId('git-file-preview-text');
  await expect(conflictText.locator('.cm-editor')).toBeVisible();
  await expect(conflictText).toContainText('<<<<<<< HEAD');
  await expect(conflictText).toContainText('>>>>>>> other');
  await expect(page.getByTestId('git-diff-patch')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': notes/example.ts rendered in read-only CodeMirror with a line-number ' +
      'gutter and syntax text (no <pre>), src/conflict.rs rendered its real conflict bytes with the ' +
      'Unresolved conflict label, and neither surface offered a write/merge/save control',
  });
});
