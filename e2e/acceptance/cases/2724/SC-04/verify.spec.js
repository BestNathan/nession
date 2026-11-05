'use strict';
// #2724 SC-04: routes obey the selected-Session/no-Session model, a pushed
// Workspace detail keeps its own dirty leave, and every swipe route has a
// visible non-swipe alternative.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openFixtureApp,
  shellAnchor,
  startTouch,
  moveTouch,
  endTouch,
  swipe,
} = require('../../../shared/swipe-2724-cases.cjs');

test('SC-04: routes, no-Session root, dirty leave and visible controls', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-04');

  await page.setViewportSize({ width: 390, height: 844 });
  await openFixtureApp(page);
  let anchor = await shellAnchor(page);

  // Terminal -> Sessions from the left band.
  await swipe(page, {
    from: { x: anchor.leftX, y: anchor.y },
    to: { x: anchor.leftX + 160, y: anchor.y },
  });
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'sessions');

  // Sessions -> Terminal by the reverse swipe on the layer's own chrome.
  const sessionsHeaderY = Math.round(anchor.shell.y + 30);
  await swipe(page, {
    from: { x: Math.round(anchor.shell.x + anchor.shell.width / 2), y: sessionsHeaderY },
    to: { x: Math.round(anchor.shell.x + anchor.shell.width / 2) - 160, y: sessionsHeaderY },
  });
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'terminal');

  // Terminal -> Workspace from the right band.
  await swipe(page, {
    from: { x: anchor.rightX, y: anchor.y },
    to: { x: anchor.rightX - 160, y: anchor.y },
  });
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'workspace');

  // Workspace -> Terminal by the reverse swipe. The page header's Back
  // control owns its left edge, so start on its chrome title area.
  const workspaceHeader = await page.getByTestId('app-page-header').boundingBox();
  if (!workspaceHeader) throw new Error('the Workspace page header must be laid out');
  const workspaceHeaderX = Math.round(workspaceHeader.x + workspaceHeader.width / 2);
  const workspaceHeaderY = Math.round(workspaceHeader.y + workspaceHeader.height / 2);
  await swipe(page, {
    from: { x: workspaceHeaderX, y: workspaceHeaderY },
    to: { x: workspaceHeaderX + 160, y: workspaceHeaderY },
  });
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'terminal');

  // Visible, non-swipe controls reach both layers and back.
  await page.getByTestId('app-header-sessions').first().click();
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'sessions');
  await page.getByTestId('session-item-row').first().click();
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'terminal');

  await page.getByTestId('app-header-workspace').first().click();
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'workspace');
  await expect(page.getByTestId('app-page-back')).toHaveAttribute('aria-label', 'Back to terminal');
  await page.getByTestId('app-page-back').click();
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'terminal');

  // No-Session root: Workspace does not exist and is not invented.
  await openFixtureApp(page, '?selection=none', { terminal: false });
  anchor = await shellAnchor(page);
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'terminal');
  await expect(page.getByTestId('app-layer-workspace')).toHaveCount(0);

  await swipe(page, {
    from: { x: anchor.rightX, y: anchor.y },
    to: { x: anchor.rightX - 160, y: anchor.y },
  });
  await page.waitForTimeout(300);
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'terminal');
  await expect(page.getByTestId('app-layer-workspace')).toHaveCount(0);

  await swipe(page, {
    from: { x: anchor.leftX, y: anchor.y },
    to: { x: anchor.leftX + 160, y: anchor.y },
  });
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'sessions');

  // Returning to the no-Session root is labelled Home, never a fake Terminal.
  const noSessionHeaderY = Math.round(anchor.shell.y + 30);
  await startTouch(page, {
    x: Math.round(anchor.shell.x + anchor.shell.width / 2),
    y: noSessionHeaderY,
  });
  await moveTouch(page, {
    x: Math.round(anchor.shell.x + anchor.shell.width / 2) - 120,
    y: noSessionHeaderY,
  });
  await expect(page.getByTestId('app-swipe-preview')).toContainText('Home');
  await endTouch(page, {
    x: Math.round(anchor.shell.x + anchor.shell.width / 2) - 120,
    y: noSessionHeaderY,
  });
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'terminal');

  // A pushed dirty detail keeps its own leave; the shell cannot discard it.
  // Re-open the canonical Session fixture: the no-Session root has no
  // Workspace affordance by design (#1082).
  await openFixtureApp(page);
  await page.getByTestId('app-header-workspace').first().click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  await page.getByTestId('file-row-web').click();
  await page.getByTestId('file-row-web/src').click();
  await page.getByTestId('file-row-web/src/App.tsx').click();
  await page.locator('.cm-editor').waitFor();
  // The read-first viewer becomes editable through its own Edit action; only
  // then does typing create the draft the leave must guard.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('// guarded draft');
  await expect(page.getByTestId('app-page-back')).toHaveAttribute('aria-label', 'Back to Files');

  await page.getByTestId('app-page-back').click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Unsaved changes');
  await expect(dialog).toContainText('Leave anyway?');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.cm-editor')).toBeVisible();

  // The shell's own swipe is muted on this depth; it must not bypass the guard.
  const shell = await anchor.layerRoot.boundingBox();
  const editor = await page.locator('.cm-editor').boundingBox();
  if (!shell || !editor) throw new Error('the shell and editor must be laid out');
  await swipe(page, {
    from: { x: Math.round(shell.x + 2), y: Math.round(editor.y + editor.height / 2) },
    to: { x: Math.round(shell.x + 162), y: Math.round(editor.y + editor.height / 2) },
  });
  await page.waitForTimeout(300);
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'workspace');
  await expect(page.locator('.cm-editor')).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);

  await page.getByTestId('app-page-back').click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  // Activate with the keyboard: the always-mounted Radix confirmation can
  // place its overlay above the content on a reopen, so a pointer click is
  // intercepted even though the action is reachable and visible.
  await confirm.getByRole('button', { name: 'Leave without saving', exact: true }).press('Enter');
  await expect(page.getByTestId('app-page-header')).toContainText('src');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': Terminal <-> Sessions and Terminal <-> Workspace committed in ' +
      'both directions; visible header/Back controls reached the same layers; with no Session the ' +
      'Workspace layer did not exist, the leftward edge drag was a no-op, and the return preview was ' +
      'labelled Home; a pushed dirty Files editor opened its own discard guard via Back, Keep editing ' +
      'retained it, the shell swipe left the depth untouched, and Discard used the capability leave',
  });
});
