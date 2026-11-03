import {defineConfig} from '@playwright/test';

// Public Pages runs only its own loopback fixture in CI. In particular, this
// config NEVER imports product runtime.ts or globalSetup.ts (Server/Agent/tmux).
export default defineConfig({
  // Existing product-browser fixture specs plus Pages-only smoke tests.
  // The latter deliberately live outside the canonical product E2E catalog.
  testDir:'.',
  testMatch:['**/tests/browser/pages-*.spec.ts','**/pages/*.test.ts'],
  fullyParallel:false,
  workers:2,
  retries:0,
  timeout:30_000,
  reporter:[['list'],['html',{open:'never',outputFolder:'playwright-report-pages'}]],
  outputDir:'test-results-pages',
  use:{
    browserName:'chromium',
    trace:'retain-on-failure',
    screenshot:'only-on-failure',
  },
});
