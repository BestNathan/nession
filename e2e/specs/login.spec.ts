import { test, expect } from '@playwright/test';
import { waitForDashboard } from '../helpers/dashboard';
import { resetAuth } from '../helpers/reset';

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

    // Fill in the form
    await serverUrlInput.fill('ws://localhost:19090/ws');
    await authTokenInput.fill('e2e-test-token');

    // Click Connect — the form disables inputs while connecting
    await connectButton.click();

    // Wait for the Dashboard to appear (login succeeds)
    await waitForDashboard(page);

    // The filter row on the Dashboard should be visible
    await expect(page.locator('[data-testid="filter-row"]')).toBeVisible();
  });

  test('inputs are disabled while connecting', async ({ page }) => {
    await page.goto('/');
    await resetAuth(page);
    await page.goto('/');

    const serverUrlInput = page.locator('#serverUrl');
    const authTokenInput = page.locator('#authToken');
    const connectButton = page.getByRole('button', { name: 'Connect', exact: true });

    // Initially inputs are enabled
    await expect(serverUrlInput).toBeEnabled();
    await expect(authTokenInput).toBeEnabled();

    // Fill and click Connect
    await serverUrlInput.fill('ws://localhost:19090/ws');
    await authTokenInput.fill('e2e-test-token');
    await connectButton.click();

    // While connecting, inputs should be disabled
    // (the status transitions quickly, but we can check immediately after click)
    await expect(serverUrlInput).toBeDisabled();
    await expect(authTokenInput).toBeDisabled();

    // Eventually the dashboard loads and inputs are gone
    await waitForDashboard(page);
  });

  test('auto-connect via URL token parameter', async ({ page }) => {
    await page.goto('/');
    await resetAuth(page);

    // The ?token= param is read from window.location.search (before the hash).
    // The app uses HashRouter, so the URL is /?token=...#/...
    await page.goto('/?token=e2e-test-token');

    // Should skip the login page and go directly to the dashboard
    await waitForDashboard(page);
    await expect(page.locator('[data-testid="filter-row"]')).toBeVisible();
  });
});
