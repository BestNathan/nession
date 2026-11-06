'use strict';
// #2851 SC-02: search, select, context actions and empty/unreachable states are
// keyboard- and pointer-operable; no Conversation semantics are invented.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-02: search, selection, context actions and empty states work', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install({ time: new Date('2026-09-01T12:00:00Z') });
  await page.goto('/#/fixture');
  await page.getByTestId('session-item-row').first().waitFor();

  const search = page.getByLabel('Search sessions');
  await search.fill('design');
  await expect(page.getByTestId('session-item-row')).toHaveCount(1);
  await expect(page.getByTestId('session-item-title')).toHaveText('design-system');
  await search.fill('no-such-session');
  await expect(page.getByTestId('session-search-miss')).toContainText('No sessions match “no-such-session”');
  await page.getByTestId('session-search-clear').click();
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);

  await page.getByTestId('session-list-filters').click();
  await page.getByTestId('session-list-filters-panel').getByRole('button', { name: 'Offline' }).click();
  await expect(page.getByTestId('session-list-filter-chip')).toContainText('Offline');
  await expect(page.getByTestId('session-item-row')).toHaveCount(1);
  await expect(page.getByTestId('session-item-row')).toContainText('prod-shell');
  await page.getByTestId('session-list-filter-chip').click();
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);

  await page.getByTestId('session-item-devbox-01:design-system').click();
  await expect(page.locator('[data-testid="session-item-row"][data-selected="true"]')).toContainText('design-system');
  await expect(page.getByTestId('session-item-devbox-01:design-system')).toHaveAttribute('aria-current', 'true');

  const actions = page.getByTestId('session-actions-devbox-01:design-system');
  await actions.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Attach settings' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Kill session' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto('/#/fixture?sessions=none');
  await page.reload();
  await expect(page.getByTestId('session-item-row')).toHaveCount(0);
  await expect(page.getByText('No sessions yet. Select New Session to get started.')).toBeVisible();
  await expect(page.getByTestId('create-session')).toBeEnabled();

  await page.goto('/#/fixture?agents=offline');
  await page.reload();
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);
  await expect(page.getByTestId('session-item-devbox-01:fix-terminal-reconnect')).toContainText('Agent offline');
  await expect(page.getByTestId('create-session')).toBeDisabled();
  await page.getByTestId('session-list-filters').click();
  await page.getByTestId('session-list-filters-panel').getByRole('button', { name: 'Online' }).click();
  await expect(page.getByTestId('session-search-miss')).toContainText('No sessions match this filter.');
  await page.getByTestId('session-filter-clear').click();
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': search filtered and cleared, the no-match and empty-route states were explicit, ' +
      'an offline-Agent filter and its clear affordance were operable, the selected row carried aria-current, ' +
      'the overflow menu opened by keyboard with both actions, and Sessions on an unreachable Agent remained listed',
  });
});
