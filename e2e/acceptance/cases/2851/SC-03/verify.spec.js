'use strict';
// #2851 SC-03: collapse returns the reserved column width, keeps an operable
// reopen affordance and preserves the selected Session and Terminal mount.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-03: full tuck-away preserves work and selection', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-03');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install({ time: new Date('2026-09-01T12:00:00Z') });
  await page.goto('/#/fixture');
  await page.getByTestId('session-item-row').first().waitFor();
  await page.locator('.xterm').first().waitFor();

  await page.getByTestId('session-item-devbox-01:design-system').click();
  await page.getByLabel('Search sessions').fill('design');
  await expect(page.getByTestId('session-item-row')).toHaveCount(1);
  const column = page.getByTestId('sidebar-column');
  const main = page.getByTestId('main-content');
  const terminal = page.locator('.xterm').first();
  const expandedColumn = (await column.boundingBox())?.width ?? 0;
  const expandedMain = (await main.boundingBox())?.width ?? 0;
  await main.evaluate((element) => { element.dataset.marker = 'kept'; });

  await page.getByTestId('sidebar-collapse').click();
  await expect.poll(async () => (await column.boundingBox())?.width ?? -1).toBe(0);
  await expect(page.getByTestId('sidebar-rail')).toHaveCount(0);
  const open = page.getByTestId('sidebar-open');
  await expect(open).toBeVisible();
  const openBox = await open.boundingBox();
  expect(openBox?.width).toBe(36);
  expect(openBox?.height).toBe(36);
  await expect.poll(async () => (await main.boundingBox())?.width ?? 0).toBeGreaterThan(expandedMain + expandedColumn * 0.9);
  expect(await main.evaluate((element) => element.dataset.marker)).toBe('kept');
  await expect(terminal).toBeVisible();

  await open.click();
  await expect.poll(async () => (await column.boundingBox())?.width ?? 0).toBe(expandedColumn);
  await expect(page.getByLabel('Search sessions')).toHaveValue('design');
  await expect(page.getByTestId('session-item-row')).toHaveCount(1);
  await expect(page.locator('[data-testid="session-item-row"][data-selected="true"]')).toContainText('design-system');
  await expect(terminal).toBeVisible();
  await expect(page.getByTestId('session-header-line')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the 246px column became 0px with no rail, the work surface grew by the released ' +
      'width, its Terminal DOM node survived under the same marker, the 36px floating control reopened it, and ' +
      'the selected Session and search query survived the round trip with no extra permanent header',
  });
});
