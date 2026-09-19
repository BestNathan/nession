import { expect, type Page } from '@playwright/test';

/**
 * Wait until the shell is fully rendered.
 *
 * `Shell` renders a `[data-testid="shell"]` root
 * that is always present after a successful login. Waiting for it is a
 * reliable signal that the WebSocket handshake, agent/session fetch and
 * initial render have completed.
 *
 * In CI, cargo build + agent startup can take 30-60 seconds, so we use a
 * generous 90-second timeout.
 */
export async function waitForShell(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="shell"]')).toBeVisible({
    timeout: 90_000,
  });
}
