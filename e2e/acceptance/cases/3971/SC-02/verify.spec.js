'use strict';
// #3971 SC-02: in the App Claude, Git and Files roots/deep views, one header
// shows a meaningful primary title and a truthful ancestor/context subtitle,
// context-appropriate priority actions and More only when needed; Back and the
// optional Stack Sheet navigate the correct destination under the same dirty
// guard, with no second page bar at 375/390/430.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openClaudeApp,
  chooseBrowse,
  back,
} = require('../../../shared/claude-app-browser.cjs');
const helper = require('../../../shared/app-workspace-3971-browser.cjs');

function title(page) {
  return page.getByTestId('app-page-header').locator('h1');
}

function oneHeader(page) {
  return expect(page.getByTestId('app-page-header')).toHaveCount(1);
}

test('SC-02: one App header with truthful titles, ancestry and guarded navigation', async ({ page }) => {
  test.setTimeout(115_000);
  const { sha } = verifiedRuntime('SC-02');

  // ── Canonical widths: root context and one pushed Files detail ──
  for (const viewport of helper.appViewports()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await helper.openWorkspace(page, 'files');

    await oneHeader(page);
    await expect(title(page)).toHaveText('Files');
    const rootSubtitle = await helper.subtitleText(page);
    expect(rootSubtitle.length).toBeGreaterThan(0);
    expect(rootSubtitle).not.toBe('Files');

    for (const id of ['file-row-web', 'file-row-web/src', 'file-row-web/src/App.tsx']) {
      await page.getByTestId(id).click();
    }
    await oneHeader(page);
    await expect(title(page)).toHaveText('App.tsx');
    await expect(page.getByTestId('app-page-subtitle-text')).toHaveText('Files / web / src');
    await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to src');

    const overflow = await helper.pageOverflow(page);
    expect(overflow.documentScrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);
  }

  // ── The deep Claude stack: primary title and actual ancestry per depth ──
  await page.setViewportSize({ width: 390, height: 844 });
  await openClaudeApp(page);
  await oneHeader(page);
  await expect(title(page)).toHaveText('Claude Code');
  await expect(page.getByTestId('app-page-action-browse')).toHaveAccessibleName('Browse Claude');
  await expect(page.getByTestId('app-page-more')).toHaveAccessibleName('More actions');

  await chooseBrowse(page, 'transcripts');
  await oneHeader(page);
  await expect(title(page)).toHaveText('Transcripts');
  await expect(page.getByTestId('app-page-subtitle-text')).toHaveText('Claude Code');

  await page.getByTestId('transcript-open').first().click();
  await oneHeader(page);
  await expect(title(page)).toHaveText('Transcript execution view');
  await expect(page.getByTestId('app-page-subtitle-text')).toHaveText(
    'Claude Code / Transcripts',
  );

  await page.getByTestId('transcript-record-open').first().click();
  await expect(page.getByTestId('app-page-subtitle-text')).toHaveText(
    'Claude Code / Transcripts / Transcript execution view',
  );
  const recordTitle = (await title(page).innerText()).trim();

  await page.getByTestId('claude-app-record-raw').click();
  await oneHeader(page);
  await expect(title(page)).toHaveText('Raw record');
  await expect(page.getByTestId('app-page-subtitle-text')).toContainText(
    'Transcript execution view',
  );

  // The optional Stack Sheet projects the real path root-first. Choosing an
  // ancestor lands exactly where Back through the same levels would.
  await page.getByTestId('app-page-subtitle').click();
  await expect(page.getByTestId('app-stack-sheet')).toBeVisible();
  await expect(page.getByTestId('app-stack-current')).toContainText('Raw record');
  await page
    .locator('[data-testid^="app-stack-ancestor-"]')
    .filter({ hasText: 'Transcripts' })
    .click();
  await oneHeader(page);
  await expect(title(page)).toHaveText('Transcripts');
  await back(page);
  await expect(title(page)).toHaveText('Claude Code');

  // ── Files root/deep views: a dirty editor cannot be discarded by a shortcut ──
  await helper.openWorkspace(page, 'files');
  for (const id of ['file-row-web', 'file-row-web/src', 'file-row-web/src/App.tsx']) {
    await page.getByTestId(id).click();
  }
  const edit = page.getByRole('button', { name: 'Edit' });
  if ((await edit.count()) > 0) {
    await edit.click();
  }
  await page.locator('.cm-content').click();
  await page.keyboard.type('x');

  await page.getByTestId('app-page-subtitle').click();
  await expect(page.getByTestId('app-stack-sheet')).toBeVisible();
  await page
    .locator('[data-testid^="app-stack-ancestor-"]')
    .filter({ hasText: 'Files' })
    .click();

  // The ancestor jump runs the same guard as Back: it asks, and Cancel keeps
  // the editor and the depth exactly where they were.
  await expect(page.getByRole('alertdialog')).toContainText('Unsaved changes');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.cm-editor')).toBeVisible();
  await oneHeader(page);
  await expect(title(page)).toHaveText('App.tsx');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 375/390/430 the Files root showed one header with a ' +
      'Session context line and the pushed web/src/App.tsx showed "App.tsx" over ' +
      '"Files / web / src" with Back to src; the Claude stack showed Transcripts → ' +
      'Transcript execution view → ' + recordTitle + ' → Raw record with truthful ' +
      'root-first ancestry, Browse + More, and a Stack Sheet ancestor jump; a dirty ' +
      'editor blocked the same ancestor jump behind the unsaved-changes guard and ' +
      'Cancel preserved it.',
  });
});
