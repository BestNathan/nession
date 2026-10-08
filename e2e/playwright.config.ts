import { defineConfig } from '@playwright/test';

import { E2E_WEB_URL } from './runtime';
import { FIXTURE_SCREENSHOT } from './helpers/fixtureVisual';

/**
 * E2E test configuration.
 *
 * The real Server + Agent + isolated tmux + production Web lifecycle is owned
 * by `acceptance/runtime/full-stack.mjs`. `globalSetup.ts` provisions that
 * shared runtime before the regression suite and returns its teardown.
 *
 * Playwright therefore owns browser/test behavior only; protocol/runtime
 * Acceptance verifiers can consume the same stack without importing or
 * launching Playwright.
 */

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFilePath}/{arg}-{platform}{ext}',

  // Spread from the canonical helper rather than restated. These three keys used
  // to be written twice — here and in `helpers/fixtureVisual.ts` — and the two
  // copies had silently drifted apart in meaning: every `fixture-visual` case
  // spreads the helper, so this block was fully shadowed for all 28 of them, and
  // a second, unreviewed tolerance sat here waiting for the first spec that
  // called `toHaveScreenshot` without it (#1038).
  expect: {
    toHaveScreenshot: { ...FIXTURE_SCREENSHOT },
  },

  globalSetup: require.resolve('./globalSetup'),

  use: {
    baseURL: E2E_WEB_URL,
    // `retain-on-failure`, not `on-first-retry`. A trace only when a retry
    // happens means the most interesting failures — the deterministic ones —
    // are the ones with no evidence: `fixture-app.spec.ts` failed on all three
    // attempts, so every retry produced a trace that the *first* attempt's
    // failure had already been superseded by, and the artifact upload came back
    // empty. This also screenshots each failure for free.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

});
