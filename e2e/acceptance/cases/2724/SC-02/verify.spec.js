'use strict';
// #2724 SC-02: the work surface keeps the touches that begin in it. Center
// drags, vertical history scrolling and diagonal surrender never page; a
// genuine touchcancel and multitouch cancel; a pointer cancel does not end the
// held native touch. A real mouse-aware TUI is covered by the same start
// ownership: its touches begin in the xterm surface, not the shell edge.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openFixtureApp,
  shellAnchor,
  startTouch,
  moveTouch,
  endTouch,
  cancelTouch,
  secondFinger,
  pointerCancellation,
} = require('../../../shared/swipe-2724-cases.cjs');

async function xtermRows(page) {
  return page.locator('.xterm-rows').innerText();
}

test('SC-02: xterm owns center, vertical, diagonal and cancelled contacts', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');

  await page.setViewportSize({ width: 390, height: 844 });
  await openFixtureApp(page);
  const { layerRoot, y, leftX, rightX, leftGuardX } = await shellAnchor(page);
  const viewport = await page.locator('[data-terminal-viewport]').first().boundingBox();
  if (!viewport) {
    throw new Error('the terminal viewport must be laid out');
  }
  const center = {
    x: Math.round(viewport.x + viewport.width / 2),
    y: Math.round(viewport.y + viewport.height / 2),
  };
  const baseline = await xtermRows(page);

  // Center-origin horizontal drag belongs to xterm.
  await startTouch(page, center);
  await moveTouch(page, { x: center.x + 140, y: center.y });
  await endTouch(page, { x: center.x + 140, y: center.y });
  await page.waitForTimeout(300);
  await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');
  expect(await xtermRows(page)).toBe(baseline);

  // The outer guard belongs to the OS edge gesture; the shell must not claim
  // it even though the target is the xterm work surface (#2724).
  await startTouch(page, { x: leftGuardX, y });
  await moveTouch(page, { x: leftGuardX + 160, y });
  await endTouch(page, { x: leftGuardX + 160, y });
  await page.waitForTimeout(300);
  await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');

  // Vertical history scrolling from the edge is content's, and cannot turn
  // into a page later in the same contact.
  await startTouch(page, { x: leftX, y });
  await moveTouch(page, { x: leftX + 18, y: y + 160 });
  await expect(layerRoot).toHaveAttribute('data-swipe-reason', 'vertical');
  await moveTouch(page, { x: leftX + 260, y: y + 160 });
  await endTouch(page, { x: leftX + 260, y: y + 160 });
  await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');

  // Diagonal from the right band: the vertical axis wins.
  await startTouch(page, { x: rightX, y });
  await moveTouch(page, { x: rightX - 20, y: y + 140 });
  await endTouch(page, { x: rightX - 20, y: y + 140 });
  await expect(layerRoot).toHaveAttribute('data-swipe-reason', 'vertical');
  await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');

  // A genuine native touchcancel ends the contact.
  await startTouch(page, { x: leftX, y });
  await moveTouch(page, { x: leftX + 160, y });
  await cancelTouch(page, { x: leftX + 160, y });
  await expect(layerRoot).toHaveAttribute('data-swipe-reason', 'native-touchcancel');
  await page.waitForTimeout(300);
  await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');

  // A second finger cancels rather than paging under two contacts.
  await startTouch(page, { x: leftX, y });
  await moveTouch(page, { x: leftX + 120, y });
  await secondFinger(page, { x: leftX + 120, y }, { x: leftX + 200, y });
  await expect(layerRoot).toHaveAttribute('data-swipe-reason', 'multitouch');
  await page.waitForTimeout(300);
  await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');

  // Browser-generated pointer cancellation is not the native touch's owner:
  // the held drag still completes.
  await startTouch(page, { x: leftX, y });
  await moveTouch(page, { x: leftX + 80, y });
  await pointerCancellation(page);
  await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'navigation');
  await moveTouch(page, { x: leftX + 160, y });
  await endTouch(page, { x: leftX + 160, y });
  await expect(layerRoot).toHaveAttribute('data-layer', 'sessions');
  expect(await xtermRows(page)).toBe(baseline);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': a center drag on xterm did not page; a vertical edge drag ' +
      'surrendered and stayed surrendered after a later horizontal move; a diagonal from the right band ' +
      'was vertical; real touchcancel and multitouch cancelled with their reasons recorded; a ' +
      'pointercancel/lostpointercapture race did not end the held touch, which then committed; xterm ' +
      'rendered rows were unchanged throughout',
  });
});
