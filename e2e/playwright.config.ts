import { defineConfig } from '@playwright/test';

import { E2E_WEB_URL } from './runtime';
import { FIXTURE_SCREENSHOT } from './helpers/fixtureVisual';

/**
 * E2E test configuration.
 *
 * The real Server + Agent + isolated tmux + production Web lifecycle is owned
 * by `e2e/runner/runtime/full-stack.js`. `globalSetup.ts` provisions that
 * shared runtime before the regression suite and returns its teardown.
 *
 * Playwright therefore owns browser/test behavior only; protocol/runtime
 * Acceptance verifiers can consume the same stack without importing or
 * launching Playwright.
 */

/**
 * File-level parallelism for this config.
 *
 * Independent spec files run concurrently against one shared full-stack
 * runtime, so a file that restarts the Agent (`restartAgent()` in
 * `terminal-consistency-faults.spec.ts`) can kill a sibling file's session
 * (#4483). The Issue-selected lane therefore runs with `E2E_WORKERS=1`
 * (serial across files); the periodic Full lane keeps the measured default.
 * An invalid override fails closed rather than silently falling back.
 */
function e2eWorkers(): number {
  const raw = process.env.E2E_WORKERS;
  if (raw === undefined || raw === '') return 2;
  const workers = Number(raw);
  if (!Number.isInteger(workers) || workers < 1 || workers > 32) {
    throw new Error(`E2E_WORKERS must be an integer in [1, 32]; got ${raw}`);
  }
  return workers;
}

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // File-level parallelism: independent spec files run concurrently. Measured
  // on ubuntu-24.04 (#2470): the full suite drops from 11m21s to 8m17s of job
  // time with zero failed/skipped/flaky tests. Tests inside a file stay
  // serial (fullyParallel: false), preserving their shared-session semantics.
  workers: e2eWorkers(),
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
