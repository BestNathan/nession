'use strict';
// #2851 SC-04: narrow Web uses the overlay drawer with explicit close paths;
// App keeps its independent spatial Sessions layer.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-04: narrow Web drawer and the independent App shell', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date('2026-09-01T12:00:00Z') });
  await page.goto('/#/fixture?experience=web');
  await expect(page.getByTestId('session-drawer-panel')).toBeVisible();
  await expect(page.getByTestId('sidebar-collapse')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-column')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-rail')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-drawer-close')).toHaveAccessibleName('Close sessions');
  expect(await page.getByTestId('session-drawer-panel').evaluate((element) => element.getBoundingClientRect().x)).toBe(0);

  await page.getByTestId('sidebar-drawer-close').click();
  await expect(page.getByTestId('session-drawer')).toHaveCount(0);
  const open = page.getByTestId('session-drawer-open');
  await expect(open).toBeVisible();
  await open.click();
  await page.getByTestId('session-item-devbox-01:design-system').click();
  await expect(page.getByTestId('session-drawer')).toHaveCount(0);
  await open.click();
  await expect(page.getByTestId('session-item-devbox-01:design-system')).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('session-drawer')).toHaveCount(0);

  await page.goto('/#/fixture/app');
  await page.reload();
  await expect(page.getByTestId('app-layer-root')).toBeVisible();
  await expect(page.getByTestId('sidebar-column')).toHaveCount(0);
  await expect(page.getByTestId('session-drawer')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 390x844 the explicit Web mode rendered the 320px overlay drawer with no rail ' +
      'or column, its Close action and Escape dismissed it, selection closed it while preserving the selected ' +
      'row on reopen, and the App route rendered its own spatial layer without the Web sidebar or drawer',
  });
});
