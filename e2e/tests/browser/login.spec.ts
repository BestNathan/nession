import { test, expect } from '@playwright/test';
import { waitForShell } from '../../helpers/shell';
import { resetAuth } from '../../helpers/reset';

/**
 * Direct WebSocket URL — bypasses vite preview's WS proxy, which has been
 * flaky in CI. The app accepts this via the `server_url` query parameter.
 */
const DIRECT_WS = 'ws://localhost:19090/ws';

// The form-login scenario is not yet implemented as an E2E test: the
// "Connecting..." state races with startup. Restore it only once there is a
// reliable readiness contract; do not leave a permanently skipped test case.
test.describe('Login', () => {
  test('auto-connect via URL token parameter', async ({ page }) => {
    await page.goto('/');
    await resetAuth(page);

    // The ?token= param is read from window.location.search (before the hash).
    // The app uses HashRouter, so the URL is /?token=...#/...
    // The server_url param is the direct WS URL — bypasses vite preview proxy.
    await page.goto(`/?token=e2e-test-token&server_url=${encodeURIComponent(DIRECT_WS)}`);

    // Should skip the login page and go directly to the shell
    await waitForShell(page);
    await expect(page.locator('[data-testid="shell"]')).toBeVisible();
    // SC-03 controlled failing revision: verify trusted Fail publication.
    // Remove this negative assertion in the subsequent proof revision.
    await expect(page.locator('[data-testid="shell"]')).toHaveCount(0);
  });
});
