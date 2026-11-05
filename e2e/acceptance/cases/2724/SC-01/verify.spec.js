'use strict';
// #2724 SC-01: one continuous touch keeps a claimed navigation alive through
// small reversals and past its origin, previews the destination progressively,
// and commits or snaps back only at release. No resting affordance exists.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openFixtureApp,
  shellAnchor,
  startTouch,
  moveTouch,
  endTouch,
  cancelTouch,
  swipe,
} = require('../../../shared/swipe-2724-cases.cjs');

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 844, height: 390 },
];

test('SC-01: continuous touch, progressive preview, release-only commit and snapback', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-01');

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await openFixtureApp(page);
    const { layerRoot, shell, y, leftX } = await shellAnchor(page);

    // Resting Terminal: no tutorial, rail or navigation overlay.
    await expect(page.getByTestId('app-swipe-preview')).toHaveCount(0);
    await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'idle');

    // Claim from the left band, preview Sessions progressively.
    await startTouch(page, { x: leftX, y });
    await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'candidate');
    await moveTouch(page, { x: leftX + 120, y });

    const preview = page.getByTestId('app-swipe-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Sessions');
    await expect(preview).toHaveAttribute('data-direction', 'right');
    const sessionsBox = await page.getByTestId('app-layer-sessions').boundingBox();
    expect(sessionsBox).not.toBeNull();
    expect(sessionsBox.width).toBeLessThanOrEqual(shell.width + 1);
    expect(sessionsBox.x).toBeGreaterThan(shell.x - 1);

    // Cross back over the origin: still held, still this destination, no
    // settle and no route change before release.
    await moveTouch(page, { x: leftX - 40, y });
    await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'navigation');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Sessions');
    await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');

    // Recover and release deliberately.
    await moveTouch(page, { x: leftX + 160, y });
    await endTouch(page, { x: leftX + 160, y });
    await expect(layerRoot).toHaveAttribute('data-layer', 'sessions');
    await expect(preview).toHaveCount(0);
    await expect(layerRoot).toHaveAttribute('data-swipe-reason', 'distance');

    // Reverse route: leftward from the Sessions layer returns to Terminal.
    const sessionsAnchor = await shellAnchor(page);
    const headerY = Math.round(sessionsAnchor.shell.y + 30);
    await swipe(page, {
      from: { x: Math.round(sessionsAnchor.shell.x + sessionsAnchor.shell.width / 2), y: headerY },
      to: { x: Math.round(sessionsAnchor.shell.x + sessionsAnchor.shell.width / 2) - 160, y: headerY },
    });
    await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');

    // Below the threshold: snapback, no route change, reason recorded.
    await startTouch(page, { x: leftX, y });
    await moveTouch(page, { x: leftX + 30, y });
    await endTouch(page, { x: leftX + 30, y });
    await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'idle');
    await expect(layerRoot).toHaveAttribute('data-swipe-reason', 'below-threshold');
    await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');
    await expect(preview).toHaveCount(0);

    // A cancelled contact leaves no preview behind either.
    await startTouch(page, { x: leftX, y });
    await moveTouch(page, { x: leftX + 160, y });
    await cancelTouch(page, { x: leftX + 160, y });
    await expect(layerRoot).toHaveAttribute('data-swipe-reason', 'native-touchcancel');
    await expect(preview).toHaveCount(0);
    await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');
  }

  // Reduced motion remains usable and still commits the release decision.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixtureApp(page);
  const reduced = await shellAnchor(page);
  await startTouch(page, { x: reduced.leftX, y: reduced.y });
  await moveTouch(page, { x: reduced.leftX + 160, y: reduced.y });
  await endTouch(page, { x: reduced.leftX + 160, y: reduced.y });
  await expect(reduced.layerRoot).toHaveAttribute('data-layer', 'sessions');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': at 375/390/430 portrait and 844x390 landscape a single touch ' +
      'crossed the slop, previewed Sessions, stayed navigation-owned through a reversal past its origin, ' +
      'committed at release, reversed back to Terminal, snapped back below threshold, and cancelled on a ' +
      'real touchcancel without a resting affordance; reduced motion still committed',
  });
});
