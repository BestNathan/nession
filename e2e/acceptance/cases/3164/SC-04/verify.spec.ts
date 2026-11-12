// #3164 SC-04: a real Chromium walkthrough of the published choice-list mock —
// current-versus-candidate rows, rich/simple anatomy, long/offline/empty states,
// keyboard selection, App touch sizing, scroll and dark mode. This is prototype
// mock evidence, not production Acceptance.
import { expect, test } from '@playwright/test';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

const PROTOTYPE_URL =
  'https://bestnathan.github.io/nession/prototypes/choice-list-3164/index.html';

async function openLocation(page: import('@playwright/test').Page) {
  const product = page.locator('#nession-product');
  await product.locator('[data-action="toggle:location"]').click();
  const popup = product.locator('#popup-location');
  await expect(popup).toBeVisible();
  await expect(popup).toBeFocused();
  return { product, popup, rows: popup.locator('.choice-row') };
}

async function contrast(page: import('@playwright/test').Page, row: import('@playwright/test').Locator) {
  return row.evaluate((element) => {
    const luminance = (css: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      const channel = (value: number) => {
        const normalized = value / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ratio = (foreground: string, background: string) => {
      const first = luminance(foreground);
      const second = luminance(background);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };
    const background = getComputedStyle(element).backgroundColor;
    const title = element.querySelector('.primary-text')!;
    const status = element.querySelector('.status') ?? element.querySelector('.sub-text')!;
    return {
      title: ratio(getComputedStyle(title).color, background),
      status: ratio(getComputedStyle(status).color, background),
    };
  });
}

test('SC-04: the published mock compares current and candidate rows and states', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-04');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(PROTOTYPE_URL);
  const product = page.locator('#nession-product');
  await expect(product).toBeVisible();
  await expect(product).toHaveAttribute('data-experience', 'web');
  await expect(product).toHaveAttribute('data-recipe', 'candidate');

  // Candidate Web: rich rows, full identity, status/path, aligned check and a
  // quiet selected surface.
  let opened = await openLocation(page);
  await expect(opened.rows).toHaveCount(3);
  await expect(opened.rows.first()).toHaveAttribute('aria-selected', 'true');
  await expect(opened.rows.first().locator('.primary-text')).toContainText('nession workspace');
  await expect(opened.rows.first().locator('.path')).toHaveText('/workspace/nession');
  await expect(opened.rows.first().locator('.end-check')).toHaveText('✓');
  const richHeight = (await opened.rows.first().boundingBox())!.height;
  expect(richHeight).toBeGreaterThan(44);
  const triggerWidth = (await product.locator('[data-action="toggle:location"]').boundingBox())!.width;
  const popupWidth = (await opened.popup.boundingBox())!.width;
  expect(popupWidth).toBeGreaterThanOrEqual(triggerWidth - 1);
  expect(await opened.popup.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    .toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth) + 1);
  const candidateSelectedBackground = await opened.rows.first().evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(candidateSelectedBackground).not.toBe('rgba(0, 0, 0, 0)');

  // Keyboard: the focused row moves, Enter commits it and closes the list.
  await page.keyboard.press('ArrowDown');
  await expect(opened.rows.nth(1)).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Enter');
  await expect(opened.popup).toHaveCount(0);
  await expect(product.locator('[data-action="toggle:location"] .trigger-value'))
    .toContainText('toolchain workspace');

  // Current recipe: the same fixture keeps the compact one-line treatment and
  // its selected row has no extra surface.
  await page.locator('[data-recipe="current"]').click();
  await expect(product).toHaveAttribute('data-recipe', 'current');
  opened = await openLocation(page);
  const currentSelectedRow = opened.popup.locator('.choice-row[aria-selected="true"]');
  const currentSelectedBackground = await currentSelectedRow.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(currentSelectedBackground).not.toBe(candidateSelectedBackground);
  await expect(currentSelectedRow.locator('.end-check')).toHaveText('✓');
  await page.keyboard.press('Escape');
  await page.locator('[data-recipe="candidate"]').click();

  // Long list: a full path wraps, the list scrolls, and no horizontal overflow
  // is introduced.
  await page.locator('[data-fixture="long"]').click();
  opened = await openLocation(page);
  await expect(opened.rows).toHaveCount(13);
  expect(await opened.popup.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await expect(opened.rows.first().locator('.path')).toContainText(
    '/workspace/projects/nession/runtime/sandboxes/provisioning/policies/agent-capabilities/very-long-location-name-for-visual-overflow-review',
  );
  expect(await opened.popup.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    .toBe(true);
  await page.screenshot({ path: '/tmp/choice-3164-long.png' });
  await page.keyboard.press('Escape');

  // Offline: every row is explicitly unavailable and Create is disabled.
  await page.locator('[data-fixture="offline"]').click();
  await product.locator('[data-action="toggle:agent"]').click();
  const agentPopup = product.locator('#popup-agent');
  await expect(agentPopup).toBeVisible();
  await expect(agentPopup.locator('.choice-row[data-disabled="true"]')).toHaveCount(3);
  await expect(agentPopup.locator('.status.offline')).toHaveCount(3);
  await expect(product.locator('.op-foot [data-action="submit"]')).toBeDisabled();
  await page.keyboard.press('Escape');

  // Empty: an honest empty list, still no Create.
  await page.locator('[data-fixture="empty"]').click();
  opened = await openLocation(page);
  await expect(opened.popup.locator('.popup-void')).toHaveText('No choices available');
  await expect(product.locator('.op-foot [data-action="submit"]')).toBeDisabled();
  await page.keyboard.press('Escape');

  expect(pageErrors, 'the public mock must not throw').toEqual([]);
  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Chromium walked the live candidate at Web 1180 — rich rows ' +
      Math.round(richHeight) + 'px with identity/path/check, list ≥ trigger and no horizontal ' +
      'overflow, keyboard commit, current recipe visibly distinct, long fixture scrolled with a ' +
      'wrapped full path, and offline/empty fixtures stayed explicit with Create disabled',
  });
});

test('SC-04: the mock exercises App sizing and dark focus/selection', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-04');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(PROTOTYPE_URL);
  const product = page.locator('#nession-product');
  await expect(product).toBeVisible();
  await page.locator('[data-np-size="390"][data-np-experience="app"]').click();
  await expect(product).toHaveAttribute('data-experience', 'app');

  // App rich rows keep the 44px touch floor and the anchored popup stays inside
  // the device.
  const opened = await openLocation(page);
  await expect(opened.rows.first()).toBeVisible();
  const appRichHeight = (await opened.rows.first().boundingBox())!.height;
  expect(appRichHeight).toBeGreaterThanOrEqual(44);
  const deviceBox = (await page.locator('[data-np-device]').boundingBox())!;
  const popupBox = (await opened.popup.boundingBox())!;
  expect(popupBox.x).toBeGreaterThanOrEqual(deviceBox.x - 1);
  expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(deviceBox.x + deviceBox.width + 1);
  expect(await product.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    .toBe(true);
  await page.keyboard.press('Escape');

  // Simple mode choices keep the App band too.
  await product.locator('[data-action="toggle:mode"]').click();
  const modePopup = product.locator('#popup-mode');
  await expect(modePopup).toBeVisible();
  for (let index = 0; index < 3; index += 1) {
    expect((await modePopup.locator('.choice-row').nth(index).boundingBox())!.height)
      .toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press('Escape');

  // Dark: selected and focused rows stay legible and distinct.
  await page.locator('[data-theme="dark"]').click();
  const dark = await openLocation(page);
  await page.keyboard.press('ArrowDown');
  await expect(dark.rows.nth(1)).toHaveAttribute('data-active', 'true');
  const selectedContrast = await contrast(page, dark.rows.first());
  const focusedContrast = await contrast(page, dark.rows.nth(1));
  expect(selectedContrast.title).toBeGreaterThanOrEqual(4.5);
  expect(selectedContrast.status).toBeGreaterThanOrEqual(4.5);
  expect(focusedContrast.title).toBeGreaterThanOrEqual(4.5);
  expect(focusedContrast.status).toBeGreaterThanOrEqual(4.5);
  expect(await dark.rows.first().evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe('rgba(0, 0, 0, 0)');
  await expect(dark.rows.first().locator('.end-check')).toBeVisible();
  await page.screenshot({ path: '/tmp/choice-3164-app-dark.png' });

  expect(pageErrors, 'the public mock must not throw').toEqual([]);
  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at App 390 rich rows measured ' + Math.round(appRichHeight) +
      'px (≥44) and stayed inside the device; simple mode rows kept the 44px band; dark selected/' +
      'focused rows measured ' + selectedContrast.title.toFixed(2) + '/' +
      selectedContrast.status.toFixed(2) + ' and ' + focusedContrast.title.toFixed(2) + '/' +
      focusedContrast.status.toFixed(2) + ' contrast',
  });
});
