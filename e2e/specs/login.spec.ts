import { test, expect } from '@playwright/test';
import { waitForDashboard } from '../helpers/dashboard';
import { resetAuth } from '../helpers/reset';

/**
 * Direct WebSocket URL — bypasses vite preview's WS proxy, which has been
 * flaky in CI. The app accepts this via the `server_url` query parameter.
 *
 * Why not rely on the preview proxy? The proxy's `ws: true` setting should
 * forward the upgrade request, but in practice the connection hangs or
 * EPIPEs intermittently in CI. Connecting directly to the Rust server
 * avoids that entire layer for tests.
 */
const DIRECT_WS = 'ws://localhost:19090/ws';

test.describe('Login', () => {
  test('form login with server URL and auth token', async ({ page }) => {
    await page.goto('/');
    await resetAuth(page);
    await page.goto('/');

    // Login page should be visible with the form fields
    const serverUrlInput = page.locator('#serverUrl');
    const authTokenInput = page.locator('#authToken');
    const connectButton = page.getByRole('button', { name: 'Connect', exact: true });

    await expect(serverUrlInput).toBeVisible();
    await expect(authTokenInput).toBeVisible();
    await expect(connectButton).toBeVisible();

    // Fill in the form — use the direct WS URL to bypass the vite preview proxy
    await serverUrlInput.fill(DIRECT_WS);
    await authTokenInput.fill('e2e-test-token');

    // Click Connect — the form disables inputs while connecting
    await connectButton.click();

    // Wait for the Dashboard to appear (login succeeds)
    await waitForDashboard(page);

    // The filter row on the Dashboard should be visible
    await expect(page.locator('[data-testid="filter-row"]')).toBeVisible();
  });

  test('auto-connect via URL token parameter', async ({ page }) => {
    await page.goto('/');
    await resetAuth(page);

    // The ?token= param is read from window.location.search (before the hash).
    // The app uses HashRouter, so the URL is /?token=...#/...
    // The server_url param is the direct WS URL — bypasses vite preview proxy.
    await page.goto(`/?token=e2e-test-token&server_url=${encodeURIComponent(DIRECT_WS)}`);

    // Should skip the login page and go directly to the dashboard
    await waitForDashboard(page);
    await expect(page.locator('[data-testid="filter-row"]')).toBeVisible();
  });
});
