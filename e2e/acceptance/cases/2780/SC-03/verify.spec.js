'use strict';
// #2780 SC-03: the full cross-capability transition at canonical narrow
// viewports, with emulated touch, real routes on release and no unintended
// edit discard. The existing #2724 root/detail swipe behaviour stays intact.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openFixtureApp,
  shellAnchor,
  swipe,
} = require('../../../shared/swipe-2724-cases.cjs');

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
];

async function swipeRight(page) {
  const anchor = await shellAnchor(page);
  await swipe(page, {
    from: { x: anchor.leftX, y: anchor.y },
    to: { x: anchor.rightX, y: anchor.y },
  });
}

async function swipeLeft(page) {
  const anchor = await shellAnchor(page);
  // The Sessions layer's list owns vertical-scroll gestures in its body; start
  // the reverse route in the chrome band, as #2724 SC-01 does.
  const x = Math.round(anchor.shell.x + anchor.shell.width / 2);
  const y = Math.round(anchor.shell.y + 30);
  await swipe(page, { from: { x, y }, to: { x: x - 160, y } });
}

test('SC-03: full App cross-capability transition at canonical narrow viewports', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-03');
  const evidence = [];
  const dialogs = [];

  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    // `goto` to the same hash URL does not reload; clear the document so each
    // viewport starts from the Terminal root with the default capability.
    await page.goto('about:blank');
    await openFixtureApp(page);

    // #2724 root behaviour is unchanged: Terminal <-> Sessions by swipe.
    await swipeRight(page);
    await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'sessions');
    await swipeLeft(page);
    await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');

    // Files root returns to Terminal by swipe (root depth owns the shell page).
    await page.getByTestId('app-header-workspace').click();
    await expect(page.getByTestId('files-app-layout')).toBeVisible();
    await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to terminal');
    await swipeRight(page);
    await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');

    // Pushed detail: the shell stands down; the document stays open.
    await page.getByTestId('app-header-workspace').click();
    for (const id of ['file-row-web', 'file-row-web/src', 'file-row-web/src/App.tsx']) {
      await page.getByTestId(id).click();
    }
    await expect(page.getByTestId('codemirror-editor')).toBeVisible();
    await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to Files');
    await swipeRight(page);
    await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'workspace');
    await expect(page.getByTestId('app-page-header')).toContainText('App.tsx');

    // The regression: switch to Agent root through the always-visible Capsule.
    // The visible Back and the shell's return swipe must agree again.
    await page.getByTestId('workspace-tool-agent').click();
    await expect(page.getByTestId('app-page-header')).toContainText('Agent');
    await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to terminal');
    await swipeRight(page);
    await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');
    await expect(page.getByTestId('app-layer-workspace')).toHaveCount(0);

    // That transition is a capability switch, not a Back: it must not present
    // a dirty-leave dialog or silently claim one was confirmed.
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    evidence.push(
      viewport.width + 'x' + viewport.height +
      ': terminal→sessions→terminal, Files root→terminal, pushed detail blocked, Agent root→terminal',
    );
  }

  expect(dialogs).toEqual([]);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': ' + evidence.join('; ') +
      '; every release moved data-layer to the named destination; the pushed detail stayed on ' +
      'workspace with its App.tsx Back; no alertdialog or native dialog was presented by any ' +
      'capability switch',
  });
});
