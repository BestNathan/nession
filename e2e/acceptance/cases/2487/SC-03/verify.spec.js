'use strict';
// #2487 SC-03: iPhone-sized Web/App viewports use actual smaller CSS font
// sizes, retain the fixed columns and calculate rows through rotation and a
// keyboard-height change; no transient erroneous remote geometry is observable.
//
// The keyboard cannot be opened in a headless Chromium; the height reduction
// a soft keyboard causes is simulated as the same viewport-height change the
// terminal observes. The claim in the evidence names that substitution.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, createAndAttach, command, countInBuffer,
} = require('../../../shared/foreground-resume-browser.cjs');

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

/** Sample the column count for a short window; every sample must be canonical. */
async function steadyColumns(page, expected) {
  for (let i = 0; i < 12; i += 1) {
    const sample = await grid(page);
    if (sample.cols !== expected) {
      throw new Error('observed a transient non-canonical grid: ' + JSON.stringify(sample));
    }
    await page.waitForTimeout(100);
  }
}

test('SC-03: phone font, fixed columns, rotation and keyboard-height rows', async ({ page }) => {
  test.setTimeout(180_000);
  const { runtime, sha } = verifiedRuntime('SC-03');

  // Attach on a desktop-sized viewport (the session's creation flows are the
  // desktop shell's), then hand the same live Session to the phone size.
  await page.setViewportSize({ width: 1280, height: 800 });
  await createAndAttach(page, expect, runtime, 'case-2487-sc03', 'Relay', null);
  await waitForShell(page, 'SC03-READY');
  expect((await grid(page)).cols).toBe(80);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => {
    const g = await grid(page);
    return g.fit === 'true' && g.cols === 80 && g.fontSize < 10;
  }, { timeout: 20_000 }).toBe(true);
  const phone = await grid(page);
  expect(phone.cols, 'the phone must keep the canonical columns').toBe(80);
  expect(phone.fontSize, 'the phone uses a smaller real CSS font').toBeLessThan(10);
  expect(phone.fontSize, 'the phone font is a real readable size').toBeGreaterThanOrEqual(6);
  expect(phone.cellWidth).toBeLessThan(14 * 0.7);
  expect(phone.contentWidth).toBeCloseTo(80 * phone.cellWidth, 1);
  expect(phone.screenWidth).toBeLessThanOrEqual(phone.viewportWidth + 1.5);
  expect(phone.fit).toBe('true');
  await steadyColumns(page, 80);

  await command(page, "printf 'SC03-PHONE-%s\\n' \"$(stty size)\"");
  await expect.poll(async () => countInBuffer(page, `SC03-PHONE-${phone.rows} 80`)
    .catch(() => 0), { timeout: 20_000 }).toBeGreaterThan(0);

  // Rotation: same columns, a different measured cell and row count.
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(async () => (await grid(page)).cols, { timeout: 15_000 }).toBe(80);
  await steadyColumns(page, 80);
  const landscape = await grid(page);
  expect(landscape.cols, 'rotation must never change the columns').toBe(80);
  expect(landscape.rows).not.toBe(phone.rows);
  expect(landscape.contentWidth).toBeCloseTo(80 * landscape.cellWidth, 1);
  expect(landscape.screenWidth).toBeLessThanOrEqual(landscape.viewportWidth + 1.5);

  await command(page, "printf 'SC03-LAND-%s\\n' \"$(stty size)\"");
  await expect.poll(async () => countInBuffer(page, `SC03-LAND-${landscape.rows} 80`)
    .catch(() => 0), { timeout: 20_000 }).toBeGreaterThan(0);

  // Keyboard-height change: the terminal's usable height shrinks, rows
  // recompute, columns do not.
  await page.setViewportSize({ width: 390, height: 520 });
  await expect.poll(async () => (await grid(page)).rows, { timeout: 15_000 })
    .toBeLessThan(phone.rows);
  await steadyColumns(page, 80);
  const keyboard = await grid(page);
  expect(keyboard.cols).toBe(80);
  expect(keyboard.fit).toBe('true');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': phone 390x844 ' + phone.cols + 'x' + phone.rows +
      ' font ' + phone.fontSize + ' cell ' + phone.cellWidth + '/' + phone.cellHeight +
      '; landscape ' + landscape.cols + 'x' + landscape.rows +
      '; keyboard-height ' + keyboard.cols + 'x' + keyboard.rows +
      '; sampled columns stayed 80 through every change',
  });
});
