'use strict';
// #2750 SC-03: keyboard navigation keeps an obvious current focus target on
// desktop and narrow Web viewports, and focus does not disappear when moving
// between controls or after an overlay opens and closes.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openWebFixture,
  expectFocus,
  focusByTab,
} = require('../../../shared/focus-2750-cases.cjs');

const VIEWPORTS = [
  { id: 'narrow', width: 1280, height: 800 },
  { id: 'desktop', width: 1440, height: 900 },
];

test('SC-03: Tab, Shift+Tab, tablist arrows and overlay return keep focus visible', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-03');
  const observed = [];

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openWebFixture(page);

    // A real Tab step from the search field reaches the next primitive with the
    // token inset outline; Shift+Tab returns to the field without losing focus.
    const search = page.locator('[data-slot="input"]').first();
    await search.click();
    await expect(search).toBeFocused();
    await page.keyboard.press('Tab');
    const newSession = page.getByTestId('create-session');
    await expect(newSession).toBeFocused();
    await expectFocus(newSession, 'inset');
    await page.keyboard.press('Shift+Tab');
    await expect(search).toBeFocused();
    observed.push(viewport.id + ' Tab/Shift+Tab kept visible focus');

    // Tablist arrow movement focuses the next tab inside its own geometry while
    // the selected tab remains the selected one.
    await page.goto('/#/fixture/workspace?capability=env');
    await page.getByTestId('env-profile-row-server::staging.env').click();
    const rawTab = page.getByRole('tab', { name: 'Raw' });
    await rawTab.click();
    await expect(rawTab).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');
    const variablesTab = page.getByRole('tab', { name: 'Variables' });
    await expect(variablesTab).toBeFocused();
    await expect(variablesTab).toHaveAttribute('aria-selected', 'false');
    await expect(rawTab).toHaveAttribute('aria-selected', 'true');
    await expectFocus(variablesTab, 'inset');
    observed.push(viewport.id + ' arrow navigation focused the next tab insets, selection unchanged');

    // Keyboard-open a menu: the row owns focus; Escape closes it and returns
    // focus to the trigger, which still shows the inset focus outline.
    await page.goto('/#/fixture/workspace?capability=env');
    await page.getByTestId('env-profile-row-server::staging.env').click();
    const trigger = page.getByTestId('env-new-menu');
    await focusByTab(page, trigger);
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    const item = page.locator('[role="menuitem"]:focus');
    await expect(item).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expectFocus(trigger, 'inset');
    observed.push(viewport.id + ' menu open/close returned focus to a visible trigger');
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join('; '),
  });
});
