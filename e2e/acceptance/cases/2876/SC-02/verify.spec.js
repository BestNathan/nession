'use strict';
// #2876 SC-02: Git's untracked JSON / JSONL / Markdown open the shared
// Preview/Raw leaves; Raw is the read-only CodeMirror source. Invalid or
// incomplete data never masquerades as a complete structured preview.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-02: structured Preview/Raw matches Files for Git rows', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=git&git=preview-states');
  await page.getByTestId('git-change-list').waitFor();

  const row = (path) => page.getByTestId('git-row-untracked').filter({ hasText: path });
  const source = () => page.getByTestId('git-file-preview-text');
  // Scope to the shared toggle: getByRole name matching is substring-based, so
  // "Preview" would also match the change-list row "src/long-preview.txt".
  const mode = () => page.getByRole('group', { name: 'View mode' });

  // JSON: tree first, Raw is source, Preview returns to the tree.
  await row('notes/data.json').click();
  await expect(page.getByRole('tree')).toBeVisible();
  await expect(page.getByText('"name"')).toBeVisible();
  await mode().getByRole('button', { name: 'Raw', exact: true, pressed: false }).click();
  await expect(source().locator('.cm-editor')).toBeVisible();
  await expect(source()).toContainText('"name": "git-viewer"');
  await expect(source().locator('pre')).toHaveCount(0);
  await mode().getByRole('button', { name: 'Preview', exact: true, pressed: false }).click();
  await expect(page.getByRole('tree')).toBeVisible();

  // JSONL: records render in the same Preview/Raw contract.
  await row('notes/events.jsonl').click();
  await expect(page.getByText('Line 1')).toBeVisible();
  await expect(page.getByText('Line 2')).toBeVisible();
  await mode().getByRole('button', { name: 'Raw', exact: true, pressed: false }).click();
  await expect(source()).toContainText('{"line":1,"ok":true}');

  // Markdown: rendered preview and the same source fallback.
  await row('notes/README.md').click();
  await expect(page.getByRole('heading', { name: 'Git preview' })).toBeVisible();
  await mode().getByRole('button', { name: 'Raw', exact: true, pressed: false }).click();
  await expect(source()).toContainText('# Git preview');

  // Invalid JSON stays usable through Raw.
  await row('notes/broken.json').click();
  await expect(page.getByText('Invalid JSON')).toBeVisible();
  await mode().getByRole('button', { name: 'Raw', exact: true, pressed: false }).click();
  await expect(source()).toContainText('"broken": true');

  // A truncated JSON answer is incomplete; no Preview is offered and the
  // source says why.
  await row('notes/truncated.json').click();
  await expect(page.getByTestId('file-view-incomplete')).toContainText(
    'Preview unavailable for incomplete content',
  );
  await expect(mode()).toHaveCount(0);
  await expect(source()).toContainText('{"name":"truncated"');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Git JSON/JSONL/Markdown rows exposed the same Preview/Raw contract ' +
      'as Files, Raw was rendered in read-only CodeMirror (no <pre>), invalid JSON kept a usable ' +
      'raw source, and truncated JSON showed an explicit incomplete notice without a Preview control',
  });
});
