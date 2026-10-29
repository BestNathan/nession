'use strict';
// #2592 SC-04: the 28px edge bands still navigate from both shell edges after
// the grid is centred, and xterm cell/selection mapping survives the fitted
// font. The band is measured from the shell edge, not the painted grid.
const { test, expect } = require('@playwright/test');
const {
  APP_VIEWPORTS, verifiedRuntime, openAppFixture,
} = require('../../../shared/terminal-density-cases.cjs');

async function swipeHorizontally(page, { y, fromX, toX }) {
  await page.evaluate(({ y: clientY, fromX: startX, toX: endX }) => {
    const targetAt = (x) => document.elementFromPoint(x, clientY) ?? document.body;
    const send = (type, x) => {
      const target = targetAt(x);
      const touch = new Touch({ identifier: 1, target, clientX: x, clientY });
      const ended = type === 'touchend';
      target.dispatchEvent(new TouchEvent(type, {
        touches: ended ? [] : [touch],
        targetTouches: ended ? [] : [touch],
        changedTouches: [touch],
        bubbles: true,
        cancelable: true,
      }));
    };
    send('touchstart', startX);
    send('touchmove', startX + (endX - startX) / 2);
    send('touchmove', endX);
    send('touchend', endX);
  }, { y, fromX, toX });
}

test('SC-04: edge navigation from both shell edges and intact cell mapping', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-04');
  await openAppFixture(page, 390, 844);

  const bounds = await page.evaluate(() => {
    const layer = document.querySelector('[data-testid="app-layer-root"]');
    const surface = document.querySelector('[data-terminal-viewport]');
    const shell = layer.getBoundingClientRect();
    const rect = surface.getBoundingClientRect();
    return {
      layer: layer.dataset.layer,
      shell: { x: shell.x, width: shell.width },
      surface: { x: rect.x, width: rect.width, y: rect.y, height: rect.height },
    };
  });
  expect(bounds.layer).toBe('terminal');
  // Centring the painted grid must not move the surface or its edge bands.
  expect(Math.abs(bounds.surface.x - bounds.shell.x), 'surface starts at the shell edge')
    .toBeLessThanOrEqual(0.5);
  expect(Math.abs(bounds.surface.width - bounds.shell.width), 'surface owns the shell width')
    .toBeLessThanOrEqual(0.5);

  const layerRoot = page.getByTestId('app-layer-root');
  const y = Math.round(bounds.surface.y + 120);

  // Left band: a rightward drag from the shell's left edge over the terminal
  // surface opens Sessions.
  await swipeHorizontally(page, {
    y, fromX: bounds.shell.x + 10, toX: bounds.shell.x + 170,
  });
  await expect(layerRoot).toHaveAttribute('data-layer', 'sessions');

  // Right band: a leftward drag from the shell's right edge returns to the
  // Terminal, proving both edges remain reachable after centring.
  await swipeHorizontally(page, {
    y, fromX: bounds.shell.x + bounds.shell.width - 10,
    toX: bounds.shell.x + bounds.shell.width - 170,
  });
  await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');

  // Cell mapping at the fitted font: a marker placed beyond the 28px band
  // selects exactly the characters under the pointer.
  await page.evaluate(() => {
    const host = document.querySelector('[data-testid="fixture-terminal"]');
    const term = host.xtermInstance;
    term.write('\x1b[2J\x1b[H');
    term.write('        SELECT-MARKER alpha beta gamma\r\n');
  });
  await page.waitForTimeout(200);
  const marker = await page.evaluate(() => {
    const host = document.querySelector('[data-testid="fixture-terminal"]');
    const row = Array.from(host.querySelectorAll('.xterm-rows > div'))
      .find((el) => el.textContent.includes('SELECT-MARKER'));
    if (!row) return null;
    const span = row.querySelector('span');
    return {
      row: row.getBoundingClientRect().toJSON(),
      span: span ? span.getBoundingClientRect().toJSON() : null,
      fontSize: host.xtermInstance.options.fontSize,
    };
  });
  expect(marker, 'the marker row must render').not.toBeNull();
  const rowY = marker.row.y + marker.row.height / 2;
  const startX = Math.max(marker.span.x + 1, bounds.shell.x + 35);
  await page.mouse.move(startX, rowY);
  await page.mouse.down();
  await page.mouse.move(marker.span.x + marker.span.width - 1, rowY, { steps: 8 });
  await page.mouse.up();
  const selection = await page.evaluate(() => {
    const host = document.querySelector('[data-testid="fixture-terminal"]');
    return host.xtermInstance.getSelection();
  });
  expect(selection, 'selection maps to the rendered cells at the fitted font')
    .toContain('MARKER');
  expect(selection).toContain('gamma');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': surface ' + bounds.surface.x + '..' +
      (bounds.surface.x + bounds.surface.width) + ' within shell ' + bounds.shell.x + '..' +
      (bounds.shell.x + bounds.shell.width) + '; left band -> sessions, right band -> terminal; ' +
      'selection "' + selection + '" at font ' + marker.fontSize,
  });
});
