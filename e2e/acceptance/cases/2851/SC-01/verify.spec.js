'use strict';
// #2851 SC-01: the wide Web column begins with Session navigation, search and
// an explicit New Session, with no Agent roster occupying the top.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-01: Session navigation leads the wide sidebar', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install({ time: new Date('2026-09-01T12:00:00Z') });
  await page.goto('/#/fixture');
  await page.getByTestId('session-item-row').first().waitFor();

  const top = page.getByTestId('sidebar-top-actions');
  await expect(top.getByTestId('sidebar-collapse')).toBeVisible();
  await expect(top.getByTestId('create-session')).toBeVisible();
  await expect(page.getByLabel('Search sessions')).toBeVisible();
  await expect(page.getByTestId('sidebar-agents')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-agents-entry')).toBeVisible();
  await expect(page.getByTestId('sidebar-session-count')).toHaveText('6');
  await expect(page.getByTestId('session-group-label')).toHaveText(['Today', 'Previous 7 days', 'Older']);
  await expect(page.locator('[data-testid="session-item-row"][data-selected="true"]')).toHaveCount(1);

  const order = await page.evaluate(() => {
    const ids = ['sidebar-top-actions', 'session-list-header', 'sidebar-agents-entry', 'sidebar-footer'];
    return ids.map((id) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().top ?? -1);
  });
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(order.every((topValue) => topValue >= 0)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the expanded Web sidebar led with the toggle, New Session and Search sessions, ' +
      'the six flat Session rows were time-grouped with exactly one current selection, no Agent roster ' +
      'was mounted until its lower entry, and no page overflow occurred at 1440x900',
  });
});
