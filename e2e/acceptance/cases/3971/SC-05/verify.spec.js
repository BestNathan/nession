'use strict';
// #3971 SC-05: in emulated touch App flows, internal right swipe Pops one valid
// Workspace depth, left swipe Forwards only when recorded, failed/cancelled
// drags snap back, a dirty Files edit blocks leave, and active work
// surfaces/platform edge/vertical gestures win their contacts; at the
// Workspace root the existing spatial return to Terminal still works and xterm
// mount/selection/scrollback remain stable.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openClaudeApp,
  chooseBrowse,
} = require('../../../shared/claude-app-browser.cjs');
const swipe = require('../../../shared/swipe-2724-cases.cjs');
const helper = require('../../../shared/app-workspace-3971-browser.cjs');

function title(page) {
  return page.getByTestId('app-page-header').locator('h1');
}

function layer(page) {
  return page.getByTestId('app-layer-root');
}

async function swipeTo(page, from, dx, cancel = false) {
  await swipe.swipe(page, {
    from,
    to: { x: Math.round(from.x + dx), y: from.y },
    cancel,
  });
}

test('SC-05: the Workspace inner stack is one touch-owned Pop/Forward coordinator', async ({ page }) => {
  test.setTimeout(115_000);
  const { sha } = verifiedRuntime('SC-05');

  // ── Canonical widths: an inner right Pop and a recorded left Forward ──
  for (const viewport of helper.appViewports()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openClaudeApp(page);
    await helper.markTerminal(page);
    await chooseBrowse(page, 'transcripts');
    await expect(title(page)).toHaveText('Transcripts');
    await expect(layer(page)).toHaveAttribute('data-workspace-stack-pop', 'Claude Code');

    const transcriptsPoint = await helper.contentPoint(
      page,
      '[data-testid="claude-app-transcripts"]',
      { fx: 0.4, fy: 0.12 },
    );
    await swipeTo(page, transcriptsPoint, 120);
    await expect(title(page)).toHaveText('Claude Code', { timeout: 10_000 });
    await expect(layer(page)).toHaveAttribute('data-layer', 'workspace');
    await expect(layer(page)).toHaveAttribute('data-workspace-stack-forward', 'Transcripts');

    const rootPoint = await helper.contentPoint(
      page,
      '[data-testid="conversation-open"]',
      { fx: 0.5, fy: 0.1 },
    );
    await swipeTo(page, rootPoint, -120);
    await expect(title(page)).toHaveText('Transcripts', { timeout: 10_000 });
    expect(await helper.terminalMarkedCount(page)).toBe(1);
  }

  // ── The arbitration and guard matrix, at 390 ──
  await page.setViewportSize({ width: 390, height: 844 });

  // No recorded forward: a leftward drag resists and snaps back.
  await openClaudeApp(page);
  await chooseBrowse(page, 'transcripts');
  const noForwardPoint = await helper.contentPoint(
    page,
    '[data-testid="claude-app-transcripts"]',
    { fx: 0.4, fy: 0.12 },
  );
  await swipeTo(page, noForwardPoint, -120);
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute(
    'data-swipe-reason',
    'no-destination',
  );
  await expect(title(page)).toHaveText('Transcripts');

  // A genuine touchcancel snaps back and keeps the depth.
  await swipe.startTouch(page, noForwardPoint);
  await swipe.moveTouch(page, { x: noForwardPoint.x - 120, y: noForwardPoint.y });
  await swipe.cancelTouch(page, { x: noForwardPoint.x - 120, y: noForwardPoint.y });
  await expect(title(page)).toHaveText('Transcripts');
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute(
    'data-swipe-reason',
    'native-touchcancel',
  );

  // A vertical drag belongs to content.
  await swipe.startTouch(page, noForwardPoint);
  await swipe.moveTouch(page, { x: noForwardPoint.x + 10, y: noForwardPoint.y + 140 });
  await swipe.endTouch(page, { x: noForwardPoint.x + 10, y: noForwardPoint.y + 140 });
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute(
    'data-swipe-reason',
    'vertical',
  );
  await expect(title(page)).toHaveText('Transcripts');

  // A touch that begins on an interactive owner is never claimed.
  const browseBox = await page.getByTestId('app-page-action-browse').boundingBox();
  if (!browseBox) {
    throw new Error('the Browse action must be laid out');
  }
  const browsePoint = {
    x: Math.round(browseBox.x + browseBox.width / 2),
    y: Math.round(browseBox.y + browseBox.height / 2),
  };
  await swipeTo(page, browsePoint, 120);
  await expect(layer(page)).toHaveAttribute('data-layer', 'workspace');
  await expect(title(page)).toHaveText('Transcripts');

  // A dirty Files editor blocks the inner Pop behind the same guard as Back.
  await helper.openWorkspace(page, 'files');
  await helper.markTerminal(page);
  for (const id of ['file-row-web', 'file-row-web/src', 'file-row-web/src/App.tsx']) {
    await page.getByTestId(id).click();
  }
  const edit = page.getByRole('button', { name: 'Edit' });
  if ((await edit.count()) > 0) {
    await edit.click();
  }
  await page.locator('.cm-content').click();
  await page.keyboard.type('x');

  const anchor = await swipe.shellAnchor(page);
  const editor = await page.locator('.cm-editor').boundingBox();
  if (!editor) {
    throw new Error('the pushed editor must be laid out');
  }
  const editorY = Math.round(editor.y + editor.height / 2);
  // Start inside the editor's own edge band: the work-surface exception, not
  // the surface interior (the dirty guard is what must decide, not ownership).
  await swipe.swipe(page, {
    from: { x: anchor.shell.x + anchor.guard + 2, y: editorY },
    to: { x: anchor.shell.x + anchor.guard + 122, y: editorY },
  });
  await expect(page.getByRole('alertdialog')).toContainText('Unsaved changes');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.cm-editor')).toBeVisible();
  await expect(title(page)).toHaveText('App.tsx');

  // The editor interior keeps its own horizontal drag (no pop).
  await swipe.swipe(page, {
    from: { x: Math.round(editor.x + editor.width * 0.7), y: editorY },
    to: { x: Math.round(editor.x + editor.width * 0.7 + 120), y: editorY },
  });
  await expect(layer(page)).toHaveAttribute('data-layer', 'workspace');
  await expect(title(page)).toHaveText('App.tsx');

  // A dirty-editor contact from the platform guard is never claimed either.
  await swipe.swipe(page, {
    from: { x: anchor.shell.x + 2, y: editorY },
    to: { x: anchor.shell.x + 122, y: editorY },
  });
  await expect(layer(page)).toHaveAttribute('data-layer', 'workspace');
  await expect(title(page)).toHaveText('App.tsx');

  // At the Workspace root the same rightward gesture still returns to the
  // Terminal, and the mounted xterm instance is the one that was there before.
  await helper.openWorkspace(page, 'files');
  await helper.markTerminal(page);
  const subtitle = await page.getByTestId('app-page-subtitle-text').boundingBox();
  if (!subtitle) {
    throw new Error('the root context line must be laid out');
  }
  await swipe.swipe(page, {
    from: {
      x: Math.round(subtitle.x + subtitle.width / 2),
      y: Math.round(subtitle.y + subtitle.height / 2),
    },
    to: {
      x: Math.round(subtitle.x + subtitle.width / 2 + 140),
      y: Math.round(subtitle.y + subtitle.height / 2),
    },
  });
  await expect(layer(page)).toHaveAttribute('data-layer', 'terminal', { timeout: 10_000 });
  expect(await helper.terminalMarkedCount(page)).toBe(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 375/390/430 a right inner swipe popped Claude ' +
      'Transcripts to Claude Code (layer stayed workspace, xterm marker preserved) ' +
      'and a left swipe forwarded exactly to the recorded Transcripts depth; at 390 ' +
      'an unrecorded leftward drag resisted (no-destination), touchcancel snapped ' +
      'back, a vertical drag went to content, an interactive action kept its touch, ' +
      'a dirty Files editor blocked the inner Pop behind the unsaved-changes guard ' +
      'while Cancel preserved it, the editor interior and platform guard were not ' +
      'claimed, and a Workspace-root right swipe returned to the Terminal with the ' +
      'original xterm instance still mounted.',
  });
});
