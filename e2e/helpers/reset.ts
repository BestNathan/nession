import type { Page } from '@playwright/test';

/**
 * Clear persisted auth state so the next navigation hits the login page.
 *
 * The web UI stores the auth token in localStorage and may cache session
 * state in sessionStorage.  Clearing both guarantees a clean slate.
 */
export async function resetAuth(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}
