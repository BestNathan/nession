'use strict';
// #3089 SC-03: App Attach is a quick sheet over the mounted Terminal, the full
// configuration is a pushed depth with one Back, and the explicit configure
// intent saves without attaching.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const LONG_ADDRESS =
  'wss://gateway-01.example.test:8443/nession/connection/candidate/sessions/dev-session/long-readable-address/endpoint';

async function noHorizontalOverflow(page, locator) {
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(pageOverflow).toBeLessThanOrEqual(1);
  const elementOverflow = await locator.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(elementOverflow).toBeLessThanOrEqual(1);
}

test('SC-03: quick sheet pushes settings, Back preserves the draft and Attach is explicit', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-03');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app?operation=attach&attach=long');

  const sheet = page.getByTestId('app-attach-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('fix-terminal-reconnect');
  // The Terminal stays mounted underneath the sheet.
  await expect(page.getByTestId('terminal-surface')).toHaveCount(1);
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox).not.toBeNull();
  expect(sheetBox.y + sheetBox.height).toBeCloseTo(844, 0);
  expect(sheetBox.width).toBeCloseTo(390, 0);

  await page.getByTestId('app-attach-settings-entry').click();
  const settings = page.getByTestId('app-attach-settings-page');
  await expect(settings).toBeVisible();
  await expect(settings).toContainText('Connection settings');
  await expect(page.getByTestId('app-page-header')).toHaveCount(1);

  const modeBoxes = await Promise.all(
    ['auto', 'p2p', 'relay'].map((mode) =>
      page.getByTestId(`attach-mode-${mode}`).boundingBox(),
    ),
  );
  expect(modeBoxes.every((box) => box !== null)).toBe(true);
  expect(modeBoxes[1].y).toBeGreaterThan(modeBoxes[0].y);
  expect(modeBoxes[2].y).toBeGreaterThan(modeBoxes[1].y);
  await expect(page.getByTestId('attach-address-0')).toHaveText(LONG_ADDRESS);
  await noHorizontalOverflow(page, page.getByTestId('attach-address-0'));

  const footer = page.getByTestId('app-attach-settings-page-footer');
  const footerBox = await footer.boundingBox();
  expect(footerBox).not.toBeNull();
  expect(footerBox.y + footerBox.height).toBeCloseTo(844, 0);

  await page.getByTestId('attach-mode-p2p').click();
  await page.getByTestId('app-page-back').click();
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('attach-mode-summary')).toContainText('Direct P2P connection');
  await expect(page.getByTestId('terminal-surface')).toHaveCount(1);

  await page.getByTestId('app-attach-confirm').click();
  await expect(sheet).not.toBeVisible();
  await expect(page.getByTestId('terminal-surface')).toHaveCount(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 390 quick sheet bottom-anchored over the mounted Terminal, ' +
      'settings as one-header depth with stacked modes and the full address, P2P draft survived Back, Attach was explicit',
  });
});

test('SC-03: Attach settings opens configuration directly and Save never attaches', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-03');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app?operation=attach-settings&attach=long');

  const settings = page.getByTestId('app-attach-settings-page');
  await expect(settings).toBeVisible();
  await expect(settings).toContainText('Attach settings');
  await expect(page.getByTestId('app-page-header')).toHaveCount(1);
  await expect(page.getByTestId('app-attach-sheet')).toHaveCount(0);
  await page.getByTestId('app-attach-settings-submit').click();

  await expect(settings).not.toBeVisible();
  await expect(page.getByTestId('app-attach-sheet')).toHaveCount(0);
  await expect(page.getByTestId('terminal-surface')).toHaveCount(1);
  await expect(page).not.toHaveURL(/\/terminal\//);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': explicit Attach settings opened the one-header configuration with no quick sheet, ' +
      'and Save closed it without attaching or leaving the fixture route',
  });
});
