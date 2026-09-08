import { test, expect } from '@playwright/test';
import { waitForSessionFirst } from '../helpers/sessionFirst';

// NOTE: session-lifecycle test is skipped due to tmux terminal initialization
// issues in CI environment ("terminal does not support clear").
// The agent connection problem has been resolved, but tmux session creation
// needs separate investigation for CI environments.
// TODO: Re-enable once tmux CI environment issues are resolved.
test.describe('Session lifecycle', () => {
  const SESSION_NAME = 'e2e-lifecycle';

  test.beforeEach(async ({ page }) => {
    // Use URL token to skip login. Server runs in no-auth mode (empty auth_token),
    // so any non-empty token is accepted.
    // Use direct WS URL to bypass vite preview's flaky WS proxy.
    await page.goto('/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws'));
    await waitForSessionFirst(page);
  });

  test.skip('create a session, verify it appears, then kill it', async ({ page }) => {
    // ── Wait for the agent to register ──
    // The sidebar "Create session" button is enabled only when at least one
    // agent is online. In CI, cargo build + agent startup + heartbeat can
    // take 30-60 seconds.
    const createButton = page.getByTestId('session-first-create');
    await expect(createButton).toBeEnabled({ timeout: 60_000 });

    // ── Create session ──
    await createButton.click();

    // The CreateSessionDialog should open
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Create Session')).toBeVisible();

    // Fill in session name (agent is preselected since there's only one)
    const nameInput = page.locator('#name');
    await nameInput.fill(SESSION_NAME);

    // Submit the form
    await dialog.getByRole('button', { name: 'Create' }).click();

    // Dialog should close after successful creation
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });

    // ── Verify session appears in the list ──
    // Session-first rows show the session name in a span.font-medium
    const sessionRow = page.locator('[data-testid="session-item-row"]', {
      hasText: SESSION_NAME,
    });
    await expect(sessionRow).toBeVisible({ timeout: 10_000 });

    // The meta line should contain the agent label
    await expect(
      sessionRow.locator('span.text-xs.text-muted-foreground'),
    ).toContainText('e2e-test-node', { timeout: 5_000 });

    // ── Kill session ──
    // The Kill button is in the same row as the session name.  Use the
    // row-level hover class to scope the search, since CSS-selector
    // traversal with ".." is fragile across the nested flex layout.
    // The Kill button appears on row hover (or when the row is selected).
    await sessionRow.hover();
    await sessionRow.getByRole('button', { name: 'Kill session' }).click();

    // KillConfirmDialog should open (it's an AlertDialog)
    const killDialog = page.getByRole('alertdialog');
    await expect(killDialog).toBeVisible();
    // The dialog has both a heading "Kill Session" and a confirm button
    // "Kill Session" — use heading for the visibility check to avoid the
    // strict-mode "resolved to 2 elements" violation.
    await expect(killDialog.getByRole('heading', { name: 'Kill Session' })).toBeVisible();

    // Type the session name to confirm
    const confirmInput = page.locator('#kill-confirm-name');
    await confirmInput.fill(SESSION_NAME);

    // Click the confirm button
    await killDialog.getByRole('button', { name: 'Kill Session' }).click();

    // Dialog should close
    await expect(killDialog).not.toBeVisible({ timeout: 10_000 });

    // ── Verify session disappears ──
    await expect(sessionRow).not.toBeVisible({ timeout: 10_000 });
  });
});
