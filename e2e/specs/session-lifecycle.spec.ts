import { test, expect } from '@playwright/test';
import { waitForShell } from '../helpers/shell';

// CI-gated like terminal-io.spec.ts: drives a real tmux-backed agent, which the
// e2e webServer stack only provides in CI. The historical blocker ("terminal
// does not support clear") was fixed in #633 — agent pins TERM=xterm-256color.
test.describe('Session lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    // Use URL token to skip login. Server runs in no-auth mode (empty auth_token),
    // so any non-empty token is accepted.
    // Use direct WS URL to bypass vite preview's flaky WS proxy.
    await page.goto('/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws'));
    await waitForShell(page);
  });

  test('create a session, verify it appears, then kill it', async ({ page }, testInfo) => {
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    const SESSION_NAME = `e2e-lifecycle-${testInfo.retry}-${Date.now()}`;

    // ── Wait for the agent to register ──
    // The sidebar "Create session" button is enabled only when at least one
    // agent is online. In CI, cargo build + agent startup + heartbeat can
    // take 30-60 seconds. Open the sessions drawer if the list is collapsed.
    // The sidebar is always present; there is no drawer opener to click (#748).
    const createButton = page.getByTestId('create-session');
    await expect(createButton).toBeEnabled({ timeout: 60_000 });

    // ── Create session ──
    await createButton.click();

    // The CreateSessionDialog should open
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Create Session')).toBeVisible();

    // Agent is preselected — read the label span inside SelectTrigger (#agent),
    // not the trigger's full textContent (radix appends a ▼ chevron).
    const agentLabel = (await dialog.locator('#agent > span').textContent())?.trim() ?? '';
    expect(agentLabel.length).toBeGreaterThan(0);
    expect(agentLabel).not.toBe('Select an agent');

    const nameInput = page.locator('#name');
    await nameInput.fill(SESSION_NAME);

    const sessionRow = page.locator('[data-testid="session-item-row"]', {
      hasText: SESSION_NAME,
    });

    // Submit the form
    await dialog.getByRole('button', { name: 'Create' }).click();

    // Wait for the row first — create can succeed server-side while the dialog
    // close animation lags; the row is the authoritative success signal.
    await expect(sessionRow).toBeVisible({ timeout: 15_000 });

    // The **create** dialog, named rather than `getByRole('dialog')` (#1082).
    // Creating now makes the new Session current, which runs the ordinary
    // selection path — attach included — so by the time this line runs the
    // attach dialog is the only dialog on screen and the bare role locator
    // asserted against the wrong one.
    const createDialog = page.getByRole('dialog').filter({ hasText: 'Create Session' });
    await expect(createDialog).not.toBeVisible({ timeout: 5_000 });

    // Creating enters the work rather than returning the user to the list: the
    // Session is selected and its attach flow starts. A Session created seconds
    // ago has no stored profile, so that flow asks rather than attaching
    // silently. Dismiss it — this spec is about the lifecycle, not the attach
    // choice — and the row is left selected.
    const attachDialog = page.getByRole('dialog').filter({ hasText: 'Attach' });
    await expect(attachDialog).toBeVisible({ timeout: 10_000 });
    await attachDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(attachDialog).not.toBeVisible({ timeout: 5_000 });

    // Meta line format: "{workload} · {agentLabel} · {relative time}".
    //
    // Selected by testid, not by class. This used to be
    // `span.text-xs.text-muted-foreground`, which is a selector on how the line
    // is *styled* — so any design change to the row breaks a test about its
    // content, and the failure reads as a missing element rather than as a
    // renamed class.
    //
    // The workload slot is the session's `foreground_command` — `session-item.md`
    // names it the workload hint, with `unknown` as the documented fallback. This
    // assertion read `shell ·` until #958, which pinned a placeholder: the row
    // rendered the literal string `shell` for *every* Session, so the test was
    // asserting the defect and any Session whose shell was not the placeholder
    // would have passed it by accident. CI's session runs bash.
    await expect(
      sessionRow.getByTestId('session-item-meta'),
    ).toContainText(`bash · ${agentLabel} ·`, { timeout: 5_000 });

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
