import { expect, type Page } from '@playwright/test';

/**
 * Wait until the Dashboard is fully rendered.
 *
 * The SearchBar component renders a `[data-testid="filter-row"]` element
 * that is always visible after a successful login.  Waiting for it is a
 * reliable signal that the WebSocket handshake, agent list fetch, and
 * initial render have all completed.
 *
 * In CI, cargo build + agent startup can take 30-60 seconds, so we use
 * a generous 90-second timeout.
 */
export async function waitForDashboard(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="filter-row"]')).toBeVisible({
    timeout: 90_000,
  });
}
