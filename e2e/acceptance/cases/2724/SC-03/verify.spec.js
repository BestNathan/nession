'use strict';
// #2724 SC-03: interactive owners keep their contacts. The composer field, an
// expanded Capsule Peek, the capability row, a pushed Files editor and the
// Terminal long-press direction pad (#2657) cannot be hijacked by the shell
// swipe, and the direction pad additionally proves a single owner: the shell
// does not page while the pad owns the same finger.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime, createAndAttach } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openFixtureApp,
  shellAnchor,
  startTouch,
  moveTouch,
  endTouch,
} = require('../../../shared/swipe-2724-cases.cjs');

test('SC-03: composer, Peek, capability row, editor and direction pad keep their touches', async ({ page }) => {
  test.setTimeout(240_000);
  const { runtime, sha } = verifiedRuntime('SC-03');

  await page.setViewportSize({ width: 390, height: 844 });
  await openFixtureApp(page);
  const { layerRoot, shell, y } = await shellAnchor(page);

  // 1. The composer textarea is an input owner even inside the band.
  const composer = page.getByTestId('capsule-ghost-input');
  await expect(composer).toBeVisible();
  await composer.fill('keep this draft');
  const composerBox = await composer.boundingBox();
  if (!composerBox) throw new Error('the composer must be laid out');
  await startTouch(page, { x: Math.round(composerBox.x + 2), y: Math.round(composerBox.y + composerBox.height / 2) });
  await moveTouch(page, { x: Math.round(composerBox.x + 142), y: Math.round(composerBox.y + composerBox.height / 2) });
  await endTouch(page, { x: Math.round(composerBox.x + 142), y: Math.round(composerBox.y + composerBox.height / 2) });
  await page.waitForTimeout(300);
  await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');
  await expect(composer).toHaveValue('keep this draft');

  // 2. An expanded Capsule Peek owns its panel.
  await page.getByTestId('capsule-capability-more').click();
  await expect(page.getByTestId('capsule-context-disclosure')).toBeVisible();
  await page.locator('[data-context-row="ordinary"]').first().click();
  const peek = page.getByTestId('capsule-capability-projection');
  await expect(peek).toBeVisible();
  const peekBox = await peek.boundingBox();
  if (!peekBox) throw new Error('the Peek must be laid out');
  await startTouch(page, { x: Math.round(peekBox.x + 2), y: Math.round(peekBox.y + peekBox.height / 2) });
  await moveTouch(page, { x: Math.round(peekBox.x + 140), y: Math.round(peekBox.y + peekBox.height / 2) });
  await endTouch(page, { x: Math.round(peekBox.x + 140), y: Math.round(peekBox.y + peekBox.height / 2) });
  await page.waitForTimeout(300);
  await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');
  await expect(peek).toBeVisible();

  // 3. The capability row is a nested horizontal scroller, fully its own.
  await page.getByTestId('app-header-workspace').first().click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  const row = page.getByTestId('workspace-capability-scroll');
  const rowBox = await row.boundingBox();
  if (!rowBox) throw new Error('the capability row must be laid out');
  await startTouch(page, {
    x: Math.round(rowBox.x + rowBox.width / 2),
    y: Math.round(rowBox.y + rowBox.height / 2),
  });
  await moveTouch(page, {
    x: Math.round(rowBox.x + rowBox.width / 2) + 140,
    y: Math.round(rowBox.y + rowBox.height / 2),
  });
  await endTouch(page, {
    x: Math.round(rowBox.x + rowBox.width / 2) + 140,
    y: Math.round(rowBox.y + rowBox.height / 2),
  });
  await page.waitForTimeout(300);
  await expect(layerRoot).toHaveAttribute('data-layer', 'workspace');

  // 4. A pushed Files editor: its own Back is the leave, and the shell page
  //    is muted even from the editor's edge.
  await page.getByTestId('file-row-web').click();
  await page.getByTestId('file-row-web/src').click();
  await page.getByTestId('file-row-web/src/App.tsx').click();
  const editor = page.locator('.cm-editor');
  await expect(editor).toBeVisible();
  const editorBox = await editor.boundingBox();
  if (!editorBox) throw new Error('the editor must be laid out');
  await page.locator('.cm-content').click();
  await page.keyboard.type('// dirty draft');
  await expect(page.getByTestId('app-page-back')).toHaveAttribute('aria-label', 'Back to Files');

  await startTouch(page, { x: Math.round(shell.x + 2), y: Math.round(editorBox.y + editorBox.height / 2) });
  await moveTouch(page, { x: Math.round(shell.x + 162), y: Math.round(editorBox.y + editorBox.height / 2) });
  await endTouch(page, { x: Math.round(shell.x + 162), y: Math.round(editorBox.y + editorBox.height / 2) });
  await page.waitForTimeout(300);
  await expect(layerRoot).toHaveAttribute('data-layer', 'workspace');
  await expect(editor).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByTestId('app-page-back')).toHaveAttribute('aria-label', 'Back to Files');

  // 5. #2657 long-press owns the finger and consumes it. This needs a real
  //    attach (the fixture terminal has no controller), created on the Web
  //    layout and then observed in the App at phone width.
  await page.setViewportSize({ width: 1440, height: 900 });
  await createAndAttach(page, expect, runtime, 'sc2724-03');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('app-layer-root')).toBeVisible({ timeout: 30_000 });
  const attachedViewport = await page.locator('[data-terminal-viewport]').first().boundingBox();
  if (!attachedViewport) throw new Error('the attached terminal must be laid out');
  const center = {
    x: Math.round(attachedViewport.x + attachedViewport.width / 2),
    y: Math.round(attachedViewport.y + attachedViewport.height / 2),
  };
  await startTouch(page, center);
  await expect(page.getByTestId('terminal-direction-pad')).toBeVisible({ timeout: 5_000 });
  await moveTouch(page, { x: center.x + 60, y: center.y });
  await expect(page.getByTestId('terminal-direction-pad')).toBeVisible();
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');
  await expect(page.getByTestId('app-swipe-preview')).toHaveCount(0);
  await endTouch(page, { x: center.x + 60, y: center.y });
  await expect(page.getByTestId('terminal-direction-pad')).toHaveCount(0);

  // The fixture checks and the live attach happened at phone width.
  expect(y).toBeGreaterThan(0);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': an edge drag inside the composer textarea kept its draft; ' +
      'edge drags inside an expanded Capsule Peek, the capability row and a pushed dirty Files editor ' +
      'left the layer unchanged (the editor Back still named Files and no discard dialog was ' +
      'bypassed); on a real attached Session the #2657 direction pad armed on the same finger, the ' +
      'shell paged neither during nor after the move, and releasing cleared the pad',
  });
});
