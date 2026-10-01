import { test as base, expect } from '@playwright/test';
import { waitForShell } from '../helpers/shell';
import { watchSessionReports } from '../helpers/sessionReport';

/**
 * Watch the session lists from **before the page navigates** (#1326).
 *
 * Playwright reports a WebSocket when the page *opens* one, so a listener
 * attached after `beforeEach`'s `goto` never sees the socket the app opened
 * while loading — and every frame on it is invisible. That is the difference
 * between "the report never arrived" and "the watcher never looked", and it is
 * not visible in the result: both read as the same timeout.
 *
 * A fixture rather than a line in the test body, because fixtures are set up
 * before `beforeEach` and a line in the body is not. Moving it back would
 * silently return this spec to watching nothing; the failure message counts
 * sockets, so that mistake says so instead of blaming the agent.
 */
const test = base.extend<{ reports: ReturnType<typeof watchSessionReports> }>({
  // `auto: true` is the whole mechanism, not a convenience. Playwright sets up
  // **automatic** fixtures before `beforeEach`, and non-automatic ones lazily —
  // a fixture only the test body needs is set up *after* the hook, which here
  // means after `goto`, which means after the socket exists. Written without
  // `auto`, this reads as correct and watches nothing; that is what the third
  // CI run measured (3 sockets seen, 0 frames on any of them).
  reports: [
    async ({ page }, use) => {
      await use(watchSessionReports(page));
    },
    { auto: true },
  ],
});

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

  test('create a session, verify it appears, then kill it', async ({ page, reports }, testInfo) => {
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
    // would have passed it by accident.
    //
    // Wait for the *report*, then assert the content — in that order, because
    // the two are different claims and only the first is about timing.
    //
    // A Session created a moment ago legitimately shows `unknown`: it is the
    // documented workload value until the agent reports the pane's foreground
    // command (`workloadHint` is `foreground_command ?? 'unknown'`, and the
    // design vocabulary lists `unknown` as neutral). Measured on staging, the
    // row read `unknown` and settled to `bash` 773ms later; CI has caught the
    // same row still `unknown` past 5s on a cold agent, and #1326 caught it past
    // 20s. The settle is real and its duration is not something this spec can
    // predict — which is exactly why it no longer predicts it.
    //
    // The wait is now on the **session list that carries the command**, not on
    // the rendered row (#1326). That splits the two claims this comment always
    // said were different: if the report never arrives, the wait fails and
    // *says* that — it is the agent/server leg — and the assertion below is
    // left to be about the renderer, which is the only leg this spec owns.
    // `20s` used to be a guess at a rendering latency; the ceiling now sits on
    // the report.
    //
    // `sessionReport.ts` carries the reasoning, including why this is still a
    // timeout and why that is not the same thing as a duration allowance.
    const reportedCommand = await reports.waitForCommand(SESSION_NAME);

    // Asserted against what the server reported rather than against the literal
    // `bash`, which is a pin on the environment rather than on the row: the
    // claim is that the slot shows the Session's command. #958's placeholder is
    // still caught, because it rendered `shell` for *every* Session and the
    // agent does not report that here.
    await expect(sessionRow.getByTestId('session-item-workload')).toHaveText(reportedCommand);
    await expect(
      sessionRow.getByTestId('session-item-meta'),
    ).toContainText(`${reportedCommand} · ${agentLabel} ·`);

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
