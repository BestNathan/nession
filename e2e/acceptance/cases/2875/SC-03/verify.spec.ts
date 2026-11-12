// #2875 SC-03: Attach settings and Kill launch the existing App dialogs; Kill
// stays unavailable until the exact immutable tmux name is typed; the menu
// dismisses on outside click/Escape/App-list scroll, restores focus, and never
// replaces the list.
//
// Configure and the typed-name kill are driven against the real exact-SHA
// Server/Agent; dismissal/focus are driven deterministically on the App fixture.
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { waitForShell } from '../../../../helpers/shell';
import { freezeFixtureClock, gotoFixtureApp } from '../../../../helpers/fixtureVisual';

const runtime = JSON.parse(
  fs.readFileSync(String(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE), 'utf8'),
) as { target_sha: string; server_port: number };

function serverUrl(): string {
  return 'ws://127.0.0.1:' + runtime.server_port + '/ws';
}

async function sessionIdFor(
  page: import('@playwright/test').Page,
  name: string,
): Promise<string> {
  const row = page.locator('[data-testid="session-item-row"]', { hasText: name });
  await expect(row).toBeVisible();
  const control = row.locator('button[data-testid^="session-item-"]').first();
  const testId = await control.getAttribute('data-testid');
  if (!testId || !testId.startsWith('session-item-')) {
    throw new Error('session row has no session-id control: ' + name);
  }
  return testId.slice('session-item-'.length);
}

/**
 * Create from the App Sessions layer. The shared helper waits for the new row
 * in place, but the App returns to the Terminal layer after creation; dismiss
 * the attach dialog here and let the caller reopen Sessions where the row
 * lives.
 */
async function createAppSession(page: import('@playwright/test').Page, name: string): Promise<void> {
  await expect(page.getByTestId('create-session')).toBeVisible();
  await expect(page.getByTestId('create-session')).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId('create-session').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.locator('#name').fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  const createDialog = page.getByRole('dialog').filter({ hasText: 'Create Session' });
  await expect(createDialog).not.toBeVisible({ timeout: 10_000 });
  const attachDialog = page.getByRole('dialog').filter({ hasText: 'Attach' });
  await expect(attachDialog).toBeVisible({ timeout: 10_000 });
  await attachDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(attachDialog).not.toBeVisible({ timeout: 5_000 });
}

async function openMenu(page: import('@playwright/test').Page, sessionId: string): Promise<void> {
  await page.getByTestId(`session-actions-${sessionId}`).click();
  await expect(page.getByRole('menu')).toBeVisible();
}

test('SC-03: App configure/kill dialogs, typed-name gate, dismissal and focus', async ({ page }) => {
  test.setTimeout(300_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  const name = `e2e-app-actions-${Date.now()}`;
  const alias = `App alias ${Date.now()}`;

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?token=e2e-test-token&server_url=' + encodeURIComponent(serverUrl()));
  await waitForShell(page);
  await page.getByTestId('app-header-sessions').first().click();
  await createAppSession(page, name);
  if ((await page.getByTestId('app-layer-root').getAttribute('data-layer')) !== 'sessions') {
    await page.getByTestId('app-header-sessions').first().click();
  }
  await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();
  const row = page.locator('[data-testid="session-item-row"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 10_000 });
  const sessionId = await sessionIdFor(page, name);
  // The alias replaces the display title, so row filters by tmux name stop
  // matching after the save; the immutable Session id is the stable handle.
  const control = page.getByTestId(`session-item-${sessionId}`);

  // ── Attach settings: the existing configure dialog, without attaching ──
  await openMenu(page, sessionId);
  await page.getByTestId(`session-actions-settings-${sessionId}`).click();
  const configure = page.getByRole('dialog').filter({ hasText: 'Attach' });
  await expect(configure).toBeVisible();
  await expect(configure.getByRole('button', { name: /^Save$/ })).toBeVisible();
  await expect(configure.getByRole('button', { name: /^Attach$/ })).toHaveCount(0);
  await configure.getByRole('button', { name: 'Cancel' }).click();
  await expect(configure).toHaveCount(0);
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'sessions');

  // ── Give the Session a display alias so name-vs-alias is observable ──
  await openMenu(page, sessionId);
  await page.getByTestId(`session-actions-edit-${sessionId}`).click();
  await expect(page.getByTestId('session-metadata-editor')).toBeVisible();
  await page.getByTestId('session-metadata-title-input').fill(alias);
  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-metadata-notice')).toContainText('Session ID are unchanged.');
  await page.keyboard.press('Escape');
  await expect(control).toContainText(alias);

  // ── Kill: existing dialog; only the exact tmux name unlocks confirmation ──
  await page.getByTestId(`session-actions-${sessionId}`).click();
  await page.getByTestId(`session-actions-kill-${sessionId}`).click();
  const kill = page.getByRole('alertdialog');
  await expect(kill).toBeVisible();
  const confirm = kill.getByRole('button', { name: 'Kill Session' });
  await expect(confirm).toBeDisabled();
  await page.locator('#kill-confirm-name').fill(alias);
  await expect(confirm).toBeDisabled();
  await page.locator('#kill-confirm-name').fill(name);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(kill).toHaveCount(0);
  await expect(control).toHaveCount(0, { timeout: 15_000 });

  // ── Dismissal/focus on the App-owned list (fixture, deterministic) ──
  await freezeFixtureClock(page);
  await gotoFixtureApp(page, '?sessionMetadata=normal');
  await page.getByTestId('app-header-sessions').first().click();
  const target = 'devbox-01:design-system';
  const trigger = page.getByTestId(`session-actions-${target}`);
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(menu).toBeVisible();
  await page
    .getByTestId('app-sessions-list')
    .locator('[data-slot="scroll-area-viewport"]')
    .first()
    .evaluate((element) => {
      element.scrollTop = 40;
      element.dispatchEvent(new Event('scroll'));
    });
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId('app-sessions-list')).toBeVisible();
  await expect(page.getByTestId('app-sessions-surface')).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': on ' + name + ', Attach settings opened the existing configure dialog (Save, no Attach) ' +
      'and Cancel returned to the App Sessions layer without attaching; Kill required the exact immutable Session name — the ' +
      'display alias "' + alias + '" left confirmation disabled while "' + name + '" enabled it — and the confirmed ' +
      'kill removed the row; Escape and an App-list scroll dismissed the menu and restored focus to the 44px trigger',
  });
});
