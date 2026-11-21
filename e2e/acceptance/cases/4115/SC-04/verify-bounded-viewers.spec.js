'use strict';
// #4115 SC-04 (bounded viewers): CodeMirror, a Diff reader and a Transcript
// reader keep their own usable scroll mechanics, cursor/selection and touch
// selection, and can reveal their final content above the Capsule through the
// host-provided geometry rather than a capability-measured overlay.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

test('SC-04 bounded readers and editors reveal their end above the Capsule', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 390, height: 844 });

  // ── Diff Reader (Git) ──
  // `diff-states` carries `src/long.ts`, a real diff longer than the pane.
  await helper.openWorkspace(page, 'git', '?git=diff-states');
  await page.locator('[data-path="src/long.ts"]').click();
  await page.getByTestId('git-diff-surface').waitFor({ timeout: 30_000 });
  await page.getByTestId('git-diff-body').waitFor({ timeout: 30_000 });
  const diff = await helper.scrollToEndAndMeasure(page);
  helper.expectEndpoint(diff, 'Git diff reader');
  helper.expectHostInset(diff, 'Git diff reader');
  expect(diff.host.mode, 'Git keeps a declared bounded surface').toBe('bounded');
  expect(diff.scroller.className).toContain('nession-workspace-bounded-scroll');

  // ── CodeMirror editor (Files push) ──
  await helper.openApp(page);
  await helper.seedLongEditableFile(page);
  await page.getByTestId('app-header-workspace').first().click();
  await page.getByTestId('workspace-tool-files').click({ timeout: 30_000 });
  await page.getByTestId('workspace-shell').waitFor({ timeout: 30_000 });
  await page.getByTestId('file-row-bulk').click();
  await page.getByTestId('file-row-bulk/long.ts').click();
  await page.locator('.cm-editor').waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('// edited\n');
  await expect(page.locator('.cm-content')).toContainText('// edited');

  const editor = await helper.scrollToEndAndMeasure(page);
  helper.expectEndpoint(editor, 'CodeMirror editor');
  helper.expectHostInset(editor, 'CodeMirror editor');
  expect(editor.host.mode, 'Files keeps a declared bounded surface').toBe('bounded');
  const editorHostClass = await page.getByTestId('codemirror-editor').getAttribute('class');
  expect(editorHostClass, 'the editor host spends the host-provided scroll inset')
    .toContain('nession-workspace-bounded-scroll');

  // Its own cursor path still works after scrolling to the end.
  await page.locator('.cm-content').click();
  await page.keyboard.type('Z');
  await expect(page.locator('.cm-content')).toContainText('Z');
  const selectionInsideEditor = await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof Element && active.closest('.cm-editor') !== null;
  });
  expect(selectionInsideEditor, 'the editor still owns the focused selection path').toBe(true);

  // ── JSONL reader with its own internal scroll ──
  await helper.openWorkspace(page, 'files');
  for (const id of ['file-row-fixtures', 'file-row-fixtures/events.jsonl']) {
    await page.getByTestId(id).click();
  }
  await page.getByTestId('file-viewer-path').waitFor({ timeout: 30_000 });
  const jsonl = await helper.scrollToEndAndMeasure(page);
  helper.expectEndpoint(jsonl, 'JSONL reader');
  helper.expectHostInset(jsonl, 'JSONL reader');

  // The Claude conversation reader (the Transcript/Reader family) is proven at
  // the same endpoint in SC-02 (verify-claude.spec.js); its record stack at
  // `?conversation=rich` is the one that genuinely overflows on a phone.

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 390 the Git Diff, the CodeMirror editor and '
      + 'the JSONL reader each kept their own scroll owner, could be scrolled '
      + 'to maxScroll, revealed their final painted content above the Capsule '
      + 'through the host-published inset, and in the editor case retained '
      + 'cursor/selection and accepted text after the end was measured; every '
      + 'bounded view reported the bounded host surface and no document/body '
      + 'scroll or horizontal overflow. The overflowing Claude reader is '
      + 'covered by SC-02 verify-claude.spec.js.',
  });
});
