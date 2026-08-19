import { defineConfig } from '@playwright/test';

/**
 * E2E test configuration.
 *
 * Three webServer processes are started before tests run:
 *   1. nession-server (Rust) — reads config.toml from its CWD (fixtures/server/)
 *   2. nession-agent  (Rust) — reads the config path passed as argv
 *   3. vite preview          — serves the production build from web/dist/
 *
 * The Rust services have no HTTP endpoint, so readiness is probed via TCP
 * (tcpPort).  The vite preview server speaks HTTP, so readiness is probed
 * via URL.
 *
 * Port allocation:
 *   19090 — server WebSocket (also the vite dev-server proxy target)
 *   19091 — agent WebSocket (avoids conflict with the server)
 *   4173  — vite preview (default)
 */
export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',

  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },

  webServer: [
    {
      command: 'cargo run -p nession-server',
      cwd: `${__dirname}/fixtures/server`,
      tcpPort: 19090,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'cargo run -p nession-agent -- ./fixtures/agent-config.e2e.toml',
      cwd: `${__dirname}/fixtures`,
      tcpPort: 19091,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run preview',
      cwd: `${__dirname}/../web`,
      url: 'http://localhost:4173',
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
