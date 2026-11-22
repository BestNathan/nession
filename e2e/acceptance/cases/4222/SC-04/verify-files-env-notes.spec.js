'use strict';
// #4222 SC-04 (Files viewer and Env editor): the Files source reader reaches its
// endpoint without a capability-owned page scroll, and the Env editor's
// validation note is a declared fixed context above the Capsule rather than an
// unregistered footer that can be clipped.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

test('SC-04 Files viewer and Env editor endpoints and declared notes', async ({ page }) => {
  test.setTimeout(160_000);
  const { sha } = verifiedRuntime('SC-04');

  await page.setViewportSize({ width: 390, height: 844 });

  // ── Files: a dirty structured preview declares its fixed note ──
  await helper.openApp(page);
  await helper.seedLongEditableFile(page);
  await page.evaluate(() => {
    const control = window.fixtureFiles;
    control.writeExternal(
      'notes.md',
      '# Notes\n\n' + Array.from({ length: 60 }, (_, index) => `- item ${index}`).join('\n'),
    );
  });
  await page.getByTestId('app-header-workspace').first().click();
  await page.getByTestId('workspace-tool-files').click({ timeout: 30_000 });
  await page.getByTestId('files-app-list').waitFor({ timeout: 30_000 });
  await page.locator('[data-testid="file-row-notes.md"]').click();
  await page.getByTestId('file-viewer-path').waitFor({ timeout: 30_000 });

  // Structured previews open in Preview; switch to Raw, edit, then return to
  // Preview while dirty so the stale-preview note is rendered.
  const rawToggle = page.getByRole('button', { name: 'Raw' });
  if ((await rawToggle.count()) > 0) {
    await rawToggle.first().click();
  }
  await page.getByTestId('codemirror-editor').waitFor({ timeout: 30_000 });
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n- edited');
  const previewToggle = page.getByRole('button', { name: 'Preview' });
  await previewToggle.first().click();
  await page.getByTestId('file-viewer-dirty-preview').waitFor({ timeout: 15_000 });
  helper.expectFixedClearsCapsule(
    await helper.fixedRoleState(page, 'file-viewer-dirty-preview'),
    'Files dirty-preview note',
  );

  await page.getByTestId('app-page-back').click();
  await page.getByTestId('files-app-list').waitFor({ timeout: 30_000 });

  // ── Files: the long source file is read in the declared bounded owner ──
  await page.getByTestId('file-row-bulk').click({ timeout: 30_000 });
  await page.getByTestId('files-app-list').waitFor({ timeout: 30_000 });
  await page.locator('[data-testid="file-row-long.ts"], [data-testid="file-row-bulk/long.ts"]')
    .first()
    .click();
  await page.getByTestId('codemirror-editor').waitFor({ timeout: 30_000 });

  const viewer = await helper.scrollToEndAndMeasure(page, '[data-testid="codemirror-editor"]');
  helper.expectEndpoint(viewer, 'Files source viewer');
  expect(viewer.host.mode, 'Files is a declared bounded surface').toBe('bounded');

  // The editor keeps its caret path after endpoint measurement.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('X');
  await expect(page.locator('.cm-content')).toContainText('X');

  // ── Env: the name-validation note is a declared fixed context ──
  await page.getByTestId('workspace-tool-env').click();
  await page.getByTestId('env-profile-row-server::noisy.env').waitFor({ timeout: 30_000 });
  await page.getByTestId('env-profile-row-server::noisy.env').click();
  await page.getByTestId('env-edit').click();
  await page.locator('.cm-editor').waitFor({ timeout: 30_000 });
  await expect(page.locator('.cm-content')).toContainText('LONG_LIST_KEY_00');

  const name = page.getByTestId('env-editor-name');
  await name.click();
  await name.fill('');
  await page.getByTestId('env-editor-name-note').waitFor({ timeout: 15_000 });

  helper.expectFixedClearsCapsule(
    await helper.fixedRoleState(page, 'env-editor-name-note'),
    'Env name validation',
  );

  const editor = await helper.scrollToEndAndMeasure(page, '[data-testid="codemirror-editor"]');
  helper.expectEndpoint(editor, 'Env editor');

  // No page-level scroll owner sneaked in around the editor.
  const documentState = await page.evaluate(() => ({
    html: document.documentElement.scrollTop,
    body: document.body.scrollTop,
    width: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(documentState.html).toBe(0);
  expect(documentState.body).toBe(0);
  expect(documentState.width).toBeLessThanOrEqual(documentState.inner + 1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      `exact SHA ${sha}: the Files long source reader and the Env CodeMirror editor `
      + 'each scrolled their marked bounded owner to maxScroll with the final '
      + 'painted content above the Capsule; the editor retained focus and caret. '
      + 'A dirty Markdown preview rendered the stale-preview note, which declared '
      + 'data-workspace-fixed-role and stayed above the Capsule. Clearing the Env '
      + 'profile name rendered a note declaring '
      + 'data-workspace-fixed-role that stayed entirely above the Capsule, and no '
      + 'document/body scroll or horizontal overflow appeared.',
  });
});
