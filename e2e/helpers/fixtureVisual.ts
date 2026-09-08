import type { Page } from '@playwright/test';

/**
 * Frozen wall clock for canonical fixture routes. Must stay after fixture
 * session `last_activity` timestamps in fixtureData.ts so relative labels
 * are deterministic (Phase 7 #561).
 */
export const FIXTURE_FROZEN_TIME = new Date('2026-09-01T12:00:00.000Z');

/** Shared screenshot options for canonical visual regression (#548 / #561 Phase 8). */
export const FIXTURE_SCREENSHOT = {
  animations: 'disabled' as const,
  caret: 'hide' as const,
  maxDiffPixelRatio: 0.02,
};

/** Install a fixed clock before navigation so formatRelativeTime is stable. */
export async function freezeFixtureClock(page: Page): Promise<void> {
  await page.clock.install({ time: FIXTURE_FROZEN_TIME });
}

export async function gotoFixtureShell(page: Page): Promise<void> {
  await page.goto('/#/fixture');
  await page.getByTestId('session-first-shell').waitFor();
}

export async function gotoFixtureWorkspace(page: Page): Promise<void> {
  await page.goto('/#/fixture/workspace');
  await page.getByTestId('workspace-shell').waitFor();
}

export async function gotoFixtureApp(page: Page): Promise<void> {
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-spatial-shell').waitFor();
}

/** Wait for xterm to paint fixture buffer (renderer-agnostic). */
export async function waitForFixtureTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="fixture-terminal"] .xterm-screen').waitFor();
}
