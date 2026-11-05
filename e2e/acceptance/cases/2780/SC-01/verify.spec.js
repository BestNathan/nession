'use strict';
// #2780 SC-01: after Files detail -> Capsule switch to Agent root, the visible
// header is the Agent root and the shell's return swipe reaches Terminal. The
// retired Files depth must not fence the Agent root.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openFixtureApp,
  shellAnchor,
  swipe,
} = require('../../../shared/swipe-2724-cases.cjs');

test('SC-01: a Files detail no longer fences the Agent root after a Capsule switch', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-01');

  await page.setViewportSize({ width: 390, height: 844 });
  await openFixtureApp(page);
  await page.getByTestId('app-header-workspace').click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();

  // Depth 2: open a file so Files registers a pushed depth with its own Back.
  for (const id of ['file-row-web', 'file-row-web/src', 'file-row-web/src/App.tsx']) {
    await page.getByTestId(id).click();
  }
  await expect(page.getByTestId('codemirror-editor')).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toContainText('App.tsx');
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to Files');

  // The Capsule is intentionally available at every depth (#1347). Switching
  // to Agent must publish Agent's root depth, not Files' pushed depth.
  await page.getByTestId('workspace-tool-agent').click();
  await expect(page.getByTestId('app-page-header')).toContainText('Agent');
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to terminal');
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'workspace');

  const anchor = await shellAnchor(page);
  await swipe(page, {
    from: { x: anchor.leftX, y: anchor.y },
    to: { x: anchor.rightX, y: anchor.y },
  });

  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');
  await expect(page.getByTestId('app-layer-workspace')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 390x844: after opening web/src/App.tsx (Back to Files) and ' +
      'switching to Agent with the always-visible Capsule, the header was Agent with Back to ' +
      'terminal and a rightward shell swipe on release moved data-layer to terminal, unmounting ' +
      'the Workspace layer instead of being suppressed by the retired Files depth',
  });
});
