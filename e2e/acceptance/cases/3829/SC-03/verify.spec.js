'use strict';
// #3829 SC-03: the App Claude surface is usable at 375 / 390 / 430 touch
// widths — no horizontal overflow, 44px targets, bounded scrolling — and Back
// restores the reader's scroll position because the covered layer stays
// mounted.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openClaudeApp,
  openBrowse,
  chooseBrowse,
  back,
  visibleBoxes,
  horizontalOverflow,
  scrollOwner,
  setScrollTop,
} = require('../../../shared/claude-app-browser.cjs');

const WIDTHS = [375, 390, 430];

function assertTouchTargets(boxes, label, minimum = 44) {
  expect(boxes.length, label + ' should be present').toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.height, label + ' height ' + JSON.stringify(box)).toBeGreaterThanOrEqual(minimum);
    expect(box.width, label + ' width ' + JSON.stringify(box)).toBeGreaterThanOrEqual(minimum);
  }
}

test('SC-03: 375/390/430 widths keep controls touch-safe and restore reading position', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-03');
  const measurements = [];

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    // `rich` is the long conversation corpus, which is what makes the
    // scroll-restoration assertion meaningful.
    await openClaudeApp(page, '?conversation=rich');

    const overflow = await horizontalOverflow(page);
    expect(overflow, 'App frame should exist').not.toBeNull();
    expect(overflow.documentScrollWidth, 'no document horizontal overflow')
      .toBeLessThanOrEqual(overflow.innerWidth + 1);
    expect(overflow.rootScrollWidth, 'no App-frame horizontal overflow')
      .toBeLessThanOrEqual(overflow.rootClientWidth + 1);

    const header = await page.getByTestId('app-page-header').boundingBox();
    expect(header).not.toBeNull();
    expect(header.x).toBeGreaterThanOrEqual(0);
    expect(header.x + header.width).toBeLessThanOrEqual(width + 1);

    // The conversation title wraps inside the page rather than widening it.
    const title = await page.getByTestId('conversation-open').locator('h2').first().boundingBox();
    expect(title).not.toBeNull();
    expect(title.width).toBeLessThanOrEqual(width);
    await expect(page.getByTestId('app-page-action-browse')).toBeVisible();

    // Browse sheet: five resource rows, each a touch target, inside the width.
    await openBrowse(page);
    const sheet = await page.getByTestId('claude-browse-sheet').boundingBox();
    expect(sheet).not.toBeNull();
    expect(sheet.x).toBeGreaterThanOrEqual(0);
    expect(sheet.x + sheet.width).toBeLessThanOrEqual(width + 1);
    const browseTargets = await visibleBoxes(
      page,
      '[data-testid^="claude-browse-"]:not([data-testid="claude-browse-sheet"])',
    );
    assertTouchTargets(browseTargets, 'browse rows');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('claude-browse-sheet')).toHaveCount(0);

    // Conversation list rows are touch targets too.
    await chooseBrowse(page, 'conversations');
    const conversationTargets = await visibleBoxes(
      page,
      'button:has([data-testid="conversation-candidate-title"])',
    );
    assertTouchTargets(conversationTargets, 'conversation rows');
    await back(page);

    // Transcript record rows and their Raw action.
    await chooseBrowse(page, 'transcripts');
    const transcripts = page.getByTestId('claude-app-layer-transcripts');
    await transcripts.getByTestId('transcript-open').first().click();
    const transcript = page.getByTestId('claude-app-layer-transcript');
    await transcript.getByTestId('transcript-record-open').first().waitFor({ timeout: 30_000 });
    const recordTargets = await visibleBoxes(page, '[data-testid="transcript-record-open"]');
    assertTouchTargets(recordTargets, 'transcript rows');
    const rawTargets = await visibleBoxes(page, '[data-testid="transcript-raw-open"]');
    assertTouchTargets(rawTargets, 'Raw actions');
    await back(page);
    await back(page);

    // Reading position: scroll the conversation, open a resource, return, and
    // require the same scrollTop. The root layer stayed mounted underneath.
    const before = await scrollOwner(page, 'claude-app-root');
    expect(before, 'rich conversation should have a scroll owner').not.toBeNull();
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
    const target = Math.min(240, before.scrollHeight - before.clientHeight - 10);
    const set = await setScrollTop(page, 'claude-app-root', target);
    expect(set).toBeGreaterThan(0);
    await chooseBrowse(page, 'conversations');
    await back(page);
    const restored = await scrollOwner(page, 'claude-app-root');
    expect(restored).not.toBeNull();
    expect(restored.scrollTop).toBe(set);

    measurements.push({
      width,
      browseRows: browseTargets.length,
      conversationRows: conversationTargets.length,
      recordRows: recordTargets.length,
      scrollTop: set,
      restored: restored.scrollTop,
    });
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 375/390/430 widths the App frame had no horizontal ' +
      'overflow, the browse sheet stayed inside the viewport, every Browse/' +
      'conversation/transcript/Raw target measured >=44px, and Back restored the ' +
      'conversation scrollTop exactly. Measurements: ' + JSON.stringify(measurements),
  });
});
