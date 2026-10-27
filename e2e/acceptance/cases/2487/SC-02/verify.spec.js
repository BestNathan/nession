'use strict';
// #2487 SC-02: the desktop terminal caps at its measured maximum readable
// width/font; changing the sidebar or window width below that cap adjusts the
// actual font metrics so exactly the canonical columns remain visible, without
// clipping or glyph stretching.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, createAndAttach, command, countInBuffer,
} = require('../../../shared/foreground-resume-browser.cjs');

/** The rendered grid, its font and the measured cell xterm actually draws. */
/**
 * Wait until the shell answers, without assuming a prompt string. The CI
 * runner uses bash (`runner:~$`); the local full-stack runner inherits the
 * host shell, so a typed marker is the portable readiness signal.
 */
async function waitForShell(page, marker) {
  await page.locator('.xterm').click();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await command(page, `printf '${marker}\\n'`);
    try {
      await expect.poll(async () => countInBuffer(page, marker).catch(() => 0),
        { timeout: 1000 }).toBeGreaterThan(0);
      return;
    } catch {
      await page.waitForTimeout(250);
    }
  }
  throw new Error('the shell did not answer a readiness marker');
}

function grid(page) {
  return page.evaluate(() => {
    const xterm = Array.from(document.querySelectorAll('.xterm')).find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    // The terminal this surface is showing, not any other mounted viewport.
    const host = xterm?.closest('[data-terminal-viewport]');
    const term = xterm?.parentElement?.xtermInstance;
    const cell = term?._core?._renderService?.dimensions?.css?.cell;
    const screen = document.querySelector('.xterm-screen');
    const content = host
      ? Number.parseFloat(getComputedStyle(host).getPropertyValue('--nession-local-terminal-content-width'))
      : Number.NaN;
    return {
      cols: term?.cols,
      rows: term?.rows,
      fontSize: term?.options?.fontSize,
      cellWidth: cell?.width,
      cellHeight: cell?.height,
      contentWidth: content,
      screenWidth: screen?.getBoundingClientRect().width,
      viewportWidth: host?.getBoundingClientRect().width,
      fit: host?.dataset?.terminalColsFit,
    };
  });
}

test('SC-02: fixed columns, a capped desktop width and font-only adaptation', async ({ page }) => {
  test.setTimeout(180_000);
  const { runtime, sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 1600, height: 960 });

  await createAndAttach(page, expect, runtime, 'case-2487-sc02', 'Relay', null);
  await waitForShell(page, 'SC02-READY');
  const wide = await grid(page);
  expect(Number.isFinite(wide.contentWidth), 'measured grid: ' + JSON.stringify(wide)).toBe(true);
  expect(wide.cols, 'the live Session must render its canonical columns').toBe(88);
  // The configured value is a maximum; the fit may choose a hair below it
  // when the capped content box is a few tenths of a pixel short.
  expect(wide.fontSize, 'a wide Web window is at the configured maximum').toBeLessThanOrEqual(14);
  expect(wide.fontSize, 'the wide font must not have collapsed').toBeGreaterThan(12);
  expect(wide.cellWidth).toBeGreaterThan(0);
  expect(wide.rows).toBeGreaterThan(10);
  // The drawn screen is the terminal's own content width, not the host width:
  // unused space is insets, and the glyph aspect ratio is untouched.
  expect(wide.contentWidth).toBeCloseTo(88 * wide.cellWidth, 1);
  expect(wide.screenWidth).toBeLessThanOrEqual(wide.contentWidth + 1.5);
  expect(wide.contentWidth).toBeLessThan(wide.viewportWidth - 100);
  expect(wide.fit).toBe('true');

  // The PTY agrees with the browser; the command's own output is what makes
  // the echo unable to satisfy the assertion.
  await command(page, "printf 'SC02-SIZE-%s\\n' \"$(stty size)\"");
  await expect.poll(async () => countInBuffer(page, `SC02-SIZE-${wide.rows} 88`)
    .catch(() => 0), { timeout: 20_000 }).toBeGreaterThan(0);

  // Sidebar collapse: the grid does not gain columns.
  const collapse = page.getByTestId('sidebar-collapse');
  if (await collapse.isVisible().catch(() => false)) {
    await collapse.click();
    await expect.poll(async () => (await grid(page)).cols, { timeout: 10_000 }).toBe(88);
  }

  // A narrower window below the cap: restore the sidebar (the collapse above
  // gave the capped terminal no extra room) and use a width that really is
  // below `cols × cell`; the font shrinks, rows follow the reduced height.
  const expand = page.getByTestId('sidebar-rail-expand');
  if (await expand.isVisible().catch(() => false)) {
    await expand.click();
  }
  await page.setViewportSize({ width: 720, height: 700 });
  await expect.poll(async () => (await grid(page)).fontSize, { timeout: 15_000 })
    .toBeLessThan(wide.fontSize);
  const narrow = await grid(page);
  expect(narrow.cols, 'a width change must never change the columns').toBe(88);
  expect(narrow.cellWidth).toBeLessThan(wide.cellWidth);
  expect(narrow.contentWidth).toBeCloseTo(88 * narrow.cellWidth, 1);
  expect(narrow.screenWidth).toBeLessThanOrEqual(narrow.viewportWidth + 1.5);
  expect(narrow.fit).toBe('true');
  expect(narrow.rows, 'rows follow usable height').toBeLessThan(wide.rows);

  // The remote pane sees the same columns on a size-changing refit.
  await command(page, "printf 'SC02-NARROW-%s\\n' \"$(stty size)\"");
  await expect.poll(async () => countInBuffer(page, `SC02-NARROW-${narrow.rows} 88`)
    .catch(() => 0), { timeout: 20_000 }).toBeGreaterThan(0);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': wide 1600px ' + wide.cols + 'x' + wide.rows +
      ' font ' + wide.fontSize + ' cell ' + wide.cellWidth + ' content ' + wide.contentWidth +
      '; narrow 1000px ' + narrow.cols + 'x' + narrow.rows + ' font ' + narrow.fontSize +
      ' cell ' + narrow.cellWidth + ' content ' + narrow.contentWidth,
  });
});
