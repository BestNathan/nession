'use strict';
// #2750 SC-02: pointer/touch interaction never adds an outer focus halo or a
// second frame, while selected/open/invalid states remain distinguishable.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openWebFixture,
  expectFocus,
  readFocusStyle,
  waitForFocusStyle,
} = require('../../../shared/focus-2750-cases.cjs');

test.use({ hasTouch: true });

async function tap(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('control is not laid out');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

test('SC-02: touch/pointer focus adds no second frame; selected, open and invalid stay distinguishable', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');
  const observed = [];
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWebFixture(page);

  // Touch on a text-entry field: the existing border repaints in ring. Because
  // text inputs match :focus-visible on pointer/touch focus, a second frame
  // here would appear on every tap — the exact defect this SC forbids.
  const search = page.locator('[data-slot="input"]').first();
  await tap(page, search);
  await expect(search).toBeFocused();
  const field = await expectFocus(search, 'quiet-ring');
  expect(field.border).toBe(field.ring);
  observed.push('touched field repainted only its border');

  // Touch on a button: no outline, no ring, no added border.
  const filters = page.getByTestId('session-list-filters');
  await tap(page, filters);
  await expect(filters).toBeFocused();
  const button = await expectFocus(filters, 'quiet');
  expect(button.border).toBe('rgba(0, 0, 0, 0)');
  observed.push('touched button stayed chrome-free');

  // Tabs: the pointer selects; selection remains visible (aria-selected) while
  // focus is not painted as an outer frame.
  await page.goto('/#/fixture/workspace?capability=env');
  await page.getByTestId('env-profile-row-server::staging.env').click();
  const rawTab = page.getByRole('tab', { name: 'Raw' });
  await rawTab.click();
  await expect(rawTab).toBeFocused();
  await expect(rawTab).toHaveAttribute('aria-selected', 'true');
  await expectFocus(rawTab, 'quiet');
  observed.push('pointer-selected tab stayed selected without focus chrome');

  // Menu: the open row takes the accent surface; the popup itself adds no
  // focus ring to its trigger or rows.
  const trigger = page.getByTestId('env-new-menu');
  await trigger.click();
  await page.keyboard.press('ArrowDown');
  const item = page.locator('[role="menuitem"]:focus');
  await expect(item).toHaveCount(1);
  const row = await waitForFocusStyle(item, (m) => m.background === m.accent);
  expect(row.background).toBe(row.accent);
  await expectFocus(item, 'quiet');
  await page.keyboard.press('Escape');
  observed.push('open menu located focus with the accent row surface');

  // Invalid: the destructive border keeps the error state distinguishable even
  // though focus is now an inside-the-control indicator.
  const invalid = page.locator('[data-slot="input"]').first();
  await invalid.evaluate((el) => el.setAttribute('aria-invalid', 'true'));
  await invalid.click();
  await expect(invalid).toBeFocused();
  const error = await waitForFocusStyle(invalid, (m) => m.border === m.destructive);
  expect(error.border).toBe(error.destructive);
  const outline = await readFocusStyle(invalid);
  expect(outline.outlineStyle).toBe('solid');
  expect(outline.outlineOffset).toBeLessThan(0);
  observed.push('invalid field kept the destructive border with an inset focus indicator');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join('; '),
  });
});
