'use strict';
// #3971 SC-04: App capability header/row/toolbar actions use the same icon
// semantics, accessible labels, focus and >=44px touch targets; overflow keeps
// readable text; keyboard and touch operate them; a narrow Web viewport stays
// Web and is not silently converted to App-only icon patterns.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { openClaudeApp } = require('../../../shared/claude-app-browser.cjs');
const helper = require('../../../shared/app-workspace-3971-browser.cjs');

function expectTouchSafe(boxes, label) {
  expect(boxes.length, label + ' must render').toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.width, label + ' width').toBeGreaterThanOrEqual(44);
    expect(box.height, label + ' height').toBeGreaterThanOrEqual(44);
    expect((box.label || '').length, label + ' accessible name').toBeGreaterThan(0);
  }
}

test('SC-04: one icon-first App action vocabulary with names, focus and touch targets', async ({ page }) => {
  test.setTimeout(115_000);
  const { sha } = verifiedRuntime('SC-04');

  for (const viewport of helper.appViewports()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openClaudeApp(page);

    // Header: Back + the capability's priority icon + More are all 44px and
    // every one carries an accessible name.
    expectTouchSafe(
      await helper.boxes(
        page,
        '[data-testid="app-page-back"], [data-testid="app-page-action-browse"], [data-testid="app-page-more"]',
      ),
      'Claude header actions',
    );

    // Overflow is icon + readable text, never an unlabeled icon-only choice.
    await page.getByTestId('app-page-more').click();
    const copy = page.getByTestId('app-page-action-copy');
    await expect(copy).toBeVisible();
    await expect(copy).toHaveText('Copy reference');
    expect(await copy.locator('svg').count()).toBe(1);
    await page.keyboard.press('Escape');

    // Keyboard: Tab reaches the action with a visible focus ring, and Enter
    // operates it.
    await page.getByTestId('app-page-back').focus();
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => {
      const element = document.activeElement;
      return {
        testid: element ? element.getAttribute('data-testid') : null,
        outline: element ? getComputedStyle(element).outlineWidth : null,
      };
    });
    expect(active.testid).toBe('app-page-action-browse');
    expect(active.outline).not.toBe('0px');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('claude-browse-sheet')).toBeVisible();
    await page.keyboard.press('Escape');

    // Files toolbar and its row targets use the same App control band.
    await helper.openWorkspace(page, 'files');
    expectTouchSafe(
      await helper.boxes(page, '[aria-label="Search files"], [aria-label="Folder actions"]'),
      'Files toolbar actions',
    );
    expectTouchSafe(await helper.boxes(page, '[data-testid^="file-row-"]'), 'Files rows');

    // Git's row Stage/Unstage actions meet the App floor rather than the old
    // 24px icon-xs band.
    await helper.openWorkspace(page, 'git', '?git=changed');
    await page.getByTestId('git-change-list').waitFor({ timeout: 30_000 });
    expectTouchSafe(
      await helper.boxes(page, '[data-testid="git-stage"], [data-testid="git-unstage"]'),
      'Git row actions',
    );

    const overflow = await helper.pageOverflow(page);
    expect(overflow.documentScrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);
  }

  // ── Narrow Web stays Web: no App-only header/icon treatment is introduced ──
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/#/fixture/workspace?capability=files');
  await page.getByTestId('file-workspace').waitFor({ timeout: 30_000 });
  await expect(page.getByTestId('app-page-header')).toHaveCount(0);
  await expect(page.getByTestId('app-page-action-browse')).toHaveCount(0);
  // The Web capsule still carries readable labels, so the narrow viewport did
  // not become icon-only.
  await expect(page.getByTestId('workspace-capability-capsule')).toContainText('Files');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 375/390/430 the App header Back, Browse priority ' +
      'icon and More were each >=44x44 with non-empty accessible names; More opened ' +
      'a "Copy reference" item with icon + text; keyboard Tab reached Browse with a ' +
      'visible focus ring and Enter opened Browse; Files toolbar/rows and Git ' +
      'Stage/Unstage actions were >=44px; at 1024 Web rendered no App header/icon ' +
      'testids and kept the labeled capability capsule.',
  });
});
