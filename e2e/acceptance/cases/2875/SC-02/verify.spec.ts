// #2875 SC-02: details and edit target the chosen Session without selection
// side effects; edits use the existing metadata owner (alias/description/tags),
// keep the immutable tmux identity, and state offline/unavailable and revision
// conflicts truthfully, returning to the App Sessions layer afterwards.
import { expect, test } from '@playwright/test';
import { freezeFixtureClock, gotoFixtureApp } from '../../../../helpers/fixtureVisual';

const TARGET = 'devbox-01:design-system';

async function openAppSessions(
  page: import('@playwright/test').Page,
  search: string,
): Promise<void> {
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoFixtureApp(page, search);
  if ((await page.getByTestId('app-layer-root').getAttribute('data-layer')) !== 'sessions') {
    await page.getByTestId('app-header-sessions').first().click();
  }
  await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();
}

async function openMenu(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId(`session-actions-${TARGET}`).click();
  await expect(page.getByRole('menu')).toBeVisible();
}

test('SC-02: details/edit target one Session and preserve identity and edge states', async ({ page }) => {
  test.setTimeout(240_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);

  // ── Details: target metadata + immutable identity, no selection change ──
  await openAppSessions(page, '?sessionMetadata=normal');
  const selectedRow = page.locator('[data-testid="session-item-row"][data-selected="true"]');
  const selectedBefore = await selectedRow.getAttribute('data-session-row');
  await openMenu(page);
  await page.getByTestId(`session-actions-details-${TARGET}`).click();
  const details = page.getByTestId('session-details-dialog');
  await expect(details).toBeVisible();
  await expect(page.getByTestId('session-title')).toHaveText('Design system audit');
  await expect(page.getByTestId('session-details')).toContainText(TARGET);
  expect(await selectedRow.getAttribute('data-session-row')).toBe(selectedBefore);
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'sessions');

  // ── Edit: existing metadata editor; alias/description/tags change, id not ──
  await openMenu(page);
  await page.getByTestId(`session-actions-edit-${TARGET}`).click();
  await expect(page.getByTestId('session-metadata-editor')).toBeVisible();
  await page.getByTestId('session-metadata-title-input').fill('App parity review');
  await page.getByTestId('session-metadata-description-input').fill('Four-action App menu');
  await page.getByTestId('session-metadata-tag-input').fill('parity');
  await page.getByTestId('session-metadata-add-tag').click();
  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-metadata-notice')).toContainText('Session ID are unchanged.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(`session-item-${TARGET}`)).toContainText('App parity review');
  await expect(page.getByTestId(`session-item-${TARGET}`)).toHaveCount(1);
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'sessions');

  // ── Offline Agent: details readable, editing explicitly unavailable ──
  await openAppSessions(page, '?sessionMetadata=normal&agents=offline');
  await openMenu(page);
  await page.getByTestId(`session-actions-details-${TARGET}`).click();
  await expect(page.getByTestId('session-details-dialog')).toBeVisible();
  await expect(page.getByTestId('session-title')).toHaveText('Design system audit');
  await expect(page.getByTestId('session-metadata-editing-unavailable')).toContainText(
    'Editing is unavailable while the Agent is offline.',
  );
  await expect(page.getByTestId('session-metadata-edit')).toBeDisabled();
  await page.keyboard.press('Escape');

  // ── Revision conflict: rejected save points at reload; stored title stays ──
  await openAppSessions(page, '?sessionMetadata=conflict');
  await openMenu(page);
  await page.getByTestId(`session-actions-edit-${TARGET}`).click();
  await page.getByTestId('session-metadata-title-input').fill('Conflicting edit');
  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-metadata-conflict')).toBeVisible();
  await expect(page.getByTestId('session-metadata-reload')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(`session-item-${TARGET}`)).toContainText('Design system audit');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': details and edit opened for ' + TARGET + ' while the selected Terminal Session stayed ' +
      selectedBefore + '; alias/description/tags saved through the existing metadata editor with the immutable Session id ' +
      'unchanged; the offline Agent kept details readable with editing disabled, and a revision conflict showed the ' +
      'reload action without overwriting the stored title',
  });
});
