'use strict';
// #2724 SC-05: opening, committing or cancelling a layer never remounts
// xterm, changes its grid, resets scrollback, clears the composer or drops the
// current Session/Workspace depth.
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

async function terminalState(page) {
  return page.evaluate(() => {
    const viewport = document.querySelector('[data-terminal-viewport]');
    const xterm = document.querySelector('.xterm');
    const rect = xterm?.getBoundingClientRect();
    return {
      colsFit: viewport?.getAttribute('data-terminal-cols-fit'),
      xtermCount: document.querySelectorAll('.xterm').length,
      rows: document.querySelectorAll('.xterm-rows > div').length,
      width: rect?.width,
      height: rect?.height,
    };
  });
}

test('SC-05: xterm, scrollback, composer, Session and Workspace depth survive gestures', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-05');

  await page.setViewportSize({ width: 390, height: 844 });
  await openFixtureApp(page);
  const { layerRoot, shell, y, leftX } = await shellAnchor(page);

  const xterm = page.locator('.xterm');
  await expect(xterm).toHaveCount(1);
  await xterm.evaluate((el) => el.setAttribute('data-2724-instance', 'original'));
  const rowsBefore = await page.locator('.xterm-rows').innerText();
  const metricsBefore = await terminalState(page);
  const headerBefore = await page.getByTestId('session-header-line').innerText();
  const composer = page.getByTestId('capsule-ghost-input');
  await composer.fill('draft survives gestures');

  // Preview Sessions, then cancel: everything on the root is untouched.
  await startTouch(page, { x: leftX, y });
  await moveTouch(page, { x: leftX + 160, y });
  await cancelTouch(page, { x: leftX + 160, y });
  await page.waitForTimeout(300);

  await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');
  await expect(xterm).toHaveCount(1);
  await expect(xterm).toHaveAttribute('data-2724-instance', 'original');
  expect(await page.locator('.xterm-rows').innerText()).toBe(rowsBefore);
  expect(await terminalState(page)).toEqual(metricsBefore);
  await expect(composer).toHaveValue('draft survives gestures');
  expect(await page.getByTestId('session-header-line').innerText()).toBe(headerBefore);

  // Commit to Sessions and return: the same instance and grid remain mounted.
  await swipe(page, {
    from: { x: leftX, y },
    to: { x: leftX + 160, y },
  });
  await expect(layerRoot).toHaveAttribute('data-layer', 'sessions');
  await expect(xterm).toHaveCount(1);
  await expect(xterm).toHaveAttribute('data-2724-instance', 'original');

  const sessionsHeaderY = Math.round(shell.y + 30);
  await swipe(page, {
    from: { x: Math.round(shell.x + shell.width / 2), y: sessionsHeaderY },
    to: { x: Math.round(shell.x + shell.width / 2) - 160, y: sessionsHeaderY },
  });
  await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');
  await expect(xterm).toHaveAttribute('data-2724-instance', 'original');
  expect(await terminalState(page)).toEqual(metricsBefore);
  expect(await page.locator('.xterm-rows').innerText()).toBe(rowsBefore);
  await expect(composer).toHaveValue('draft survives gestures');
  expect(await page.getByTestId('session-header-line').innerText()).toBe(headerBefore);

  // A Workspace depth is preserved when a shell preview is cancelled.
  await page.getByTestId('app-header-workspace').first().click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  await page.getByTestId('file-row-web').click();
  await page.getByTestId('file-row-web/src').click();
  await expect(page.getByTestId('app-page-header')).toContainText('src');

  // Rightward from the left edge previews Terminal; cancel it.
  await startTouch(page, { x: Math.round(shell.x + 2), y: Math.round(shell.y + 30) });
  await moveTouch(page, { x: Math.round(shell.x + 162), y: Math.round(shell.y + 30) });
  await cancelTouch(page, { x: Math.round(shell.x + 162), y: Math.round(shell.y + 30) });
  await page.waitForTimeout(300);

  await expect(layerRoot).toHaveAttribute('data-layer', 'workspace');
  await expect(page.getByTestId('app-page-header')).toContainText('src');
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  await expect(xterm).toHaveAttribute('data-2724-instance', 'original');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': a cancelled and a committed/resumed Sessions gesture left the ' +
      'same single xterm instance, the same rendered rows, cols-fit/row-count/screen geometry, the same ' +
      'Session header and the same composer draft; a cancelled Workspace -> Terminal preview kept the ' +
      'Files depth at src with the navigator still mounted',
  });
});
