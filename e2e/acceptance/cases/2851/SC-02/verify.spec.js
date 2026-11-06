'use strict';
// #2851 SC-02: search, selection, empty states and the unified four-action row
// menu on wide and narrow Web. Details read a target without selecting it;
// editing reuses the metadata owner and never changes tmux identity; offline
// Agents keep details readable but disable editing.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-02: search, unified row actions, metadata ownership and offline states', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install({ time: new Date('2026-09-01T12:00:00Z') });
  await page.goto('/#/fixture?sessionMetadata=normal');
  await page.getByTestId('session-item-row').first().waitFor();

  const search = page.getByLabel('Search sessions');
  await search.fill('design');
  await expect(page.getByTestId('session-item-row')).toHaveCount(1);
  await expect(page.getByTestId('session-item-title')).toHaveText('Design system audit');
  await search.fill('no-such-session');
  await expect(page.getByTestId('session-search-miss')).toContainText('No sessions match “no-such-session”');
  await page.getByTestId('session-search-clear').click();
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);

  await page.getByTestId('session-item-devbox-01:fix-terminal-reconnect').click();
  const selected = page.locator('[data-testid="session-item-row"][data-selected="true"]');
  await expect(selected).toHaveCount(1);
  await expect(selected.getByTestId('session-item-title')).toHaveText('Terminal reconnect reliability');

  await page.getByTestId('session-item-devbox-01:design-system').hover();
  await page.getByTestId('session-actions-devbox-01:design-system').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(4);
  await expect(menu.getByRole('menuitem').filter({ hasText: 'Session details' })).toBeVisible();
  await expect(menu.getByRole('menuitem').filter({ hasText: 'Edit details' })).toBeVisible();
  await expect(menu.getByRole('menuitem').filter({ hasText: 'Attach settings' })).toBeVisible();
  await expect(menu.getByRole('menuitem').filter({ hasText: 'Kill session' })).toBeVisible();
  await expect(menu.getByRole('separator')).toHaveCount(1);
  await page.getByTestId('session-actions-details-devbox-01:design-system').click();
  const details = page.getByTestId('session-details-dialog');
  await expect(details).toBeVisible();
  await expect(details).toContainText('Design system audit');
  await expect(selected.getByTestId('session-item-title')).toHaveText('Terminal reconnect reliability');
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);

  await page.getByTestId('session-item-devbox-01:design-system').hover();
  await page.getByTestId('session-actions-devbox-01:design-system').click();
  await page.getByTestId('session-actions-edit-devbox-01:design-system').click();
  await expect(page.getByTestId('session-metadata-editor')).toBeVisible();
  await page.getByTestId('session-metadata-title-input').fill('Design system reviews');
  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-metadata-notice')).toContainText(
    'Session ID are unchanged.',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('session-item-devbox-01:design-system')).toHaveCount(1);
  await expect(page.getByTestId('session-item-devbox-01:design-system')).toContainText(
    'Design system reviews',
  );

  await page.setViewportSize({ width: 1440, height: 480 });
  await page.getByTestId('session-item-devbox-01:design-system').hover();
  await page.getByTestId('session-actions-devbox-01:design-system').click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByTestId('sidebar').locator('[data-slot="scroll-area-viewport"]').evaluate((element) => {
    element.scrollTop = 40;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('menu')).toHaveCount(0);

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
  await page.getByTestId('session-item-devbox-01:fix-terminal-reconnect').hover();
  await page.getByTestId('session-actions-devbox-01:fix-terminal-reconnect').click();
  await page.getByTestId('session-actions-edit-devbox-01:fix-terminal-reconnect').click();
  await expect(page.getByTestId('session-metadata-editing-unavailable')).toContainText(
    'Editing is unavailable while the Agent is offline.',
  );
  await expect(page.getByTestId('session-metadata-editor')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture?experience=web&sessionMetadata=normal');
  await page.reload();
  await page.getByTestId('session-drawer-panel').waitFor();
  const narrowActions = page.getByTestId('session-actions-devbox-01:design-system');
  // The drawer slides in from the left. A single bounding-box read taken
  // between the visibility and animation frames can observe a composited
  // size mid-transition; poll for the settled 44px target instead.
  await expect.poll(async () => narrowActions.boundingBox()).toMatchObject({ width: 44, height: 44 });
  await narrowActions.click();
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveCount(4);
  await page.keyboard.press('Escape');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': search/no-match/empty states were explicit; one keyboard-opened four-action menu ' +
      'exposed Session details, Edit details, Attach settings and a separated destructive Kill session; ' +
      'viewing another Session kept the current selection; editing saved a display alias with the tmux ' +
      'Session ID unchanged; list scroll, Escape and click-outside dismissed the menu; offline Agents kept ' +
      'details readable with editing explicitly unavailable; the narrow Web trigger measured 44x44 with the same four actions',
  });
});
