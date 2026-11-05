'use strict';
// #2780 SC-02: depth-specific swipe ownership survives switching in both
// directions. A pushed detail keeps the shell out, its Back still owns the
// dirty guard, and returning to a root capability leaves the pager enabled.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openFixtureApp,
  shellAnchor,
  swipe,
} = require('../../../shared/swipe-2724-cases.cjs');

async function returnSwipe(page) {
  const anchor = await shellAnchor(page);
  await swipe(page, {
    from: { x: anchor.leftX, y: anchor.y },
    to: { x: anchor.rightX, y: anchor.y },
  });
}

test('SC-02: pushed detail ownership and its dirty guard survive capability switches', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');

  await page.setViewportSize({ width: 390, height: 844 });
  await openFixtureApp(page);
  await page.getByTestId('app-header-workspace').click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  for (const id of ['file-row-web', 'file-row-web/src', 'file-row-web/src/App.tsx']) {
    await page.getByTestId(id).click();
  }
  await expect(page.getByTestId('codemirror-editor')).toBeVisible();

  // A pushed detail owns its leave: the shell must not bypass it.
  await returnSwipe(page);
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'workspace');
  await expect(page.getByTestId('app-page-header')).toContainText('App.tsx');
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to Files');

  // Its visible Back still guards dirty edits; cancelling keeps the edit and
  // the depth, and the shell still cannot take it.
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('draft');
  await returnSwipe(page);
  await expect(page.getByTestId('app-page-header')).toContainText('App.tsx');
  await page.getByTestId('app-page-back').click();
  await expect(page.getByRole('alertdialog')).toContainText('Unsaved changes');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('app-page-header')).toContainText('App.tsx');

  // Switching to the Agent root releases the pager for the new depth; the
  // Files push is not exported as Agent's current depth.
  await page.getByTestId('workspace-tool-agent').click();
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to terminal');
  await returnSwipe(page);
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');

  // Returning to Files starts at its root (the retired detail is not
  // restored), and that root also leaves through the shell swipe. The Workspace
  // reopens on the last capability (Agent), so switch explicitly.
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-files').click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toContainText('Files');
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to terminal');
  await returnSwipe(page);
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 390x844: a pushed detail rejected the shell return swipe and its ' +
      'Back opened the unsaved-changes guard (Cancel kept the edit); switching to Agent enabled ' +
      'the return swipe to terminal; re-entering Files landed at its root, not the retired ' +
      'detail, and that root also returned to terminal by swipe',
  });
});
