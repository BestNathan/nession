'use strict';
// #2724 SC-07: Chromium + Playwright exercises the App's own swipe/navigation
// interaction at the canonical App viewports with mobile/touch emulation.
// This is emulated browser behavior, not native Safari/OS gesture proof.
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

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 844, height: 390 },
];

async function reloadApp(page) {
  await page.reload();
  await page.getByTestId('app-layer-root').waitFor({ timeout: 30_000 });
  await page.locator('.xterm').waitFor({ timeout: 30_000 });
}

async function xtermState(page) {
  return page.evaluate(() => {
    const xterm = document.querySelector('.xterm');
    const rect = xterm?.getBoundingClientRect();
    return {
      count: document.querySelectorAll('.xterm').length,
      marker: xterm?.getAttribute('data-2724-sc07-instance'),
      rows: document.querySelectorAll('.xterm-rows > div').length,
      width: rect?.width,
      height: rect?.height,
    };
  });
}

async function markXterm(page) {
  await page.locator('.xterm').evaluate((el) => el.setAttribute('data-2724-sc07-instance', 'original'));
}

test('SC-07: emulated viewports exercise preview, ownership, cancellation and stable state', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-07');

  // A. Canonical viewports: a claimed edge drag previews Sessions through a
  // reversal and commits only on release; the platform guard is not claimed.
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await openFixtureApp(page);
    const anchor = await shellAnchor(page);

    await expect(page.getByTestId('app-swipe-preview')).toHaveCount(0);
    await startTouch(page, { x: anchor.leftX, y: anchor.y });
    await moveTouch(page, { x: anchor.leftX + 120, y: anchor.y });
    const preview = page.getByTestId('app-swipe-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Sessions');
    await expect(anchor.layerRoot).toHaveAttribute('data-swipe-phase', 'navigation');

    // Small reversal past the origin clamps the preview; it does not settle.
    await moveTouch(page, { x: anchor.leftX - 40, y: anchor.y });
    await expect(anchor.layerRoot).toHaveAttribute('data-swipe-phase', 'navigation');
    await expect(preview).toBeVisible();
    await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'terminal');

    await moveTouch(page, { x: anchor.leftX + 160, y: anchor.y });
    await endTouch(page, { x: anchor.leftX + 160, y: anchor.y });
    await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'sessions');
    await expect(page.getByTestId('app-swipe-preview')).toHaveCount(0);

    // The outer guard belongs to the platform; the shell does not page there.
    await reloadApp(page);
    const guardAnchor = await shellAnchor(page);
    await startTouch(page, { x: guardAnchor.leftGuardX, y: guardAnchor.y });
    await moveTouch(page, { x: guardAnchor.leftGuardX + 160, y: guardAnchor.y });
    await endTouch(page, { x: guardAnchor.leftGuardX + 160, y: guardAnchor.y });
    await page.waitForTimeout(300);
    await expect(guardAnchor.layerRoot).toHaveAttribute('data-layer', 'terminal');

    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(overflow.doc).toBeLessThanOrEqual(overflow.viewport + 1);
  }

  // B. Cancellation, races, content ownership and orientation.
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixtureApp(page);
  let anchor = await shellAnchor(page);

  // Real touchcancel.
  await startTouch(page, { x: anchor.leftX, y: anchor.y });
  await moveTouch(page, { x: anchor.leftX + 160, y: anchor.y });
  await cancelTouch(page, { x: anchor.leftX + 160, y: anchor.y });
  await expect(anchor.layerRoot).toHaveAttribute('data-swipe-reason', 'native-touchcancel');
  await page.waitForTimeout(300);
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'terminal');

  // Multitouch.
  await startTouch(page, { x: anchor.leftX, y: anchor.y });
  await moveTouch(page, { x: anchor.leftX + 120, y: anchor.y });
  await secondFinger(page, { x: anchor.leftX + 120, y: anchor.y }, { x: anchor.leftX + 200, y: anchor.y });
  await expect(anchor.layerRoot).toHaveAttribute('data-swipe-reason', 'multitouch');
  await page.waitForTimeout(300);
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'terminal');

  // Touch-generated pointer cancellation is not the owner of a held touch.
  await startTouch(page, { x: anchor.leftX, y: anchor.y });
  await moveTouch(page, { x: anchor.leftX + 80, y: anchor.y });
  await pointerCancellation(page);
  await expect(anchor.layerRoot).toHaveAttribute('data-swipe-phase', 'navigation');
  await moveTouch(page, { x: anchor.leftX + 160, y: anchor.y });
  await endTouch(page, { x: anchor.leftX + 160, y: anchor.y });
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'sessions');

  // Vertical content gesture from the edge stays content's.
  await reloadApp(page);
  anchor = await shellAnchor(page);
  await startTouch(page, { x: anchor.leftX, y: anchor.y });
  await moveTouch(page, { x: anchor.leftX + 18, y: anchor.y + 160 });
  await expect(anchor.layerRoot).toHaveAttribute('data-swipe-reason', 'vertical');
  await moveTouch(page, { x: anchor.leftX + 260, y: anchor.y + 160 });
  await endTouch(page, { x: anchor.leftX + 260, y: anchor.y + 160 });
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'terminal');

  // Nested horizontal scroller keeps its drag.
  await page.getByTestId('app-header-workspace').first().click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  const row = page.getByTestId('workspace-capability-scroll');
  const rowBox = await row.boundingBox();
  if (!rowBox) throw new Error('the capability row must be laid out');
  const rowY = Math.round(rowBox.y + rowBox.height / 2);
  const rowX = Math.round(rowBox.x + rowBox.width / 2);
  await startTouch(page, { x: rowX, y: rowY });
  await moveTouch(page, { x: rowX + 140, y: rowY });
  await endTouch(page, { x: rowX + 140, y: rowY });
  await page.waitForTimeout(300);
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'workspace');

  // Center xterm drag is the terminal's.
  await reloadApp(page);
  anchor = await shellAnchor(page);
  const viewport = await page.locator('[data-terminal-viewport]').first().boundingBox();
  if (!viewport) throw new Error('the terminal viewport must be laid out');
  const center = { x: Math.round(viewport.x + viewport.width / 2), y: Math.round(viewport.y + viewport.height / 2) };
  await startTouch(page, center);
  await moveTouch(page, { x: center.x + 140, y: center.y });
  await endTouch(page, { x: center.x + 140, y: center.y });
  await page.waitForTimeout(300);
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'terminal');

  // Focus/composer state survives a cancelled edge drag and an orientation
  // change; the xterm instance and Session identity do not change.
  await reloadApp(page);
  anchor = await shellAnchor(page);
  await markXterm(page);
  const composer = page.getByTestId('capsule-ghost-input');
  await composer.fill('draft survives emulation');
  const before = await xtermState(page);
  const headerBefore = await page.getByTestId('session-header-line').innerText();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'terminal');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(composer).toHaveValue('draft survives emulation');

  anchor = await shellAnchor(page);
  await startTouch(page, { x: anchor.leftX, y: anchor.y });
  await moveTouch(page, { x: anchor.leftX + 160, y: anchor.y });
  await cancelTouch(page, { x: anchor.leftX + 160, y: anchor.y });
  await page.waitForTimeout(300);
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'terminal');
  await expect(composer).toHaveValue('draft survives emulation');
  expect(await xtermState(page)).toEqual(before);
  expect(await page.getByTestId('session-header-line').innerText()).toBe(headerBefore);

  // A visual-viewport shrink (the browser half of a keyboard) does not
  // navigate or create page overflow; native keyboard geometry is not claimed.
  await page.setViewportSize({ width: 390, height: 500 });
  await expect(anchor.layerRoot).toHaveAttribute('data-layer', 'terminal');
  const shrunk = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(shrunk.doc).toBeLessThanOrEqual(shrunk.viewport + 1);
  await exitKeyboard(page);
  await page.setViewportSize({ width: 390, height: 844 });

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': Chromium mobile/touch emulation at 375x812, 390x844, 430x932 ' +
      'and 844x390 previewed Sessions, survived a reversal, committed only on release, and did not claim ' +
      'the 24px platform guard; at 390x844 touchcancel, multitouch, pointercancel races, vertical ' +
      'content surrender, the capability row and center xterm ownership behaved; composer draft, xterm ' +
      'instance/rows and Session header survived a cancelled edge drag and orientation/viewport changes. ' +
      'This is simulated browser behavior, not native Mobile Safari or OS gesture proof.',
  });
});

async function exitKeyboard(page) {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}
