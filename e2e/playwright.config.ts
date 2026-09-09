import { defineConfig } from '@playwright/test';

import { E2E_ISOLATION_ENV } from './runtime';

/**
 * E2E test configuration.
 *
 * Three webServer processes are started before tests run:
 *   1. nession-server (Rust) — config path passed as argv[1]
 *   2. nession-agent  (Rust) — config path passed as argv[1]
 *   3. vite preview          — serves the production build from web/dist/
 *
 * Both Rust binaries are launched via `cargo run` from the workspace root
 * (where Cargo.toml lives). Config paths are resolved as absolute paths so
 * they do not depend on the process CWD.
 *
 * The Rust services have no HTTP endpoint, so readiness is probed via TCP
 * (tcpPort).  The vite preview server speaks HTTP, so readiness is probed
 * via URL.
 *
 * Port allocation:
 *   19090 — server WebSocket (also the vite dev-server proxy target)
 *   19091 — agent WebSocket (avoids conflict with the server)
 *   4173  — vite preview (default)
 *
 * ── Isolation ────────────────────────────────────────────────────────────
 * Every Rust process below is launched with NESSION_TMUX_SOCKET pointing at
 * this run's own socket, which the agent passes to tmux as an explicit
 * `-S <path>`. The run's tmux sessions therefore live on a server of their
 * own: invisible to `tmux ls`, and impossible to kill together with the
 * developer's real sessions.
 *
 * TMUX_TMPDIR is NOT used. It is ignored whenever $TMUX is set — i.e. whenever
 * anything runs from inside a tmux session — and tmux then silently uses the
 * default socket, which is how an earlier version of this file ended up killing
 * a developer's real tmux server (#574). `-S` is immune to $TMUX (measured).
 *
 * NESSION_HOME points into the same per-run directory, covering the server's
 * env-files lookup and its SQLite db. Both paths come from ./runtime.ts, which
 * generates them once per run and publishes them via process.env so every
 * process Playwright spawns agrees on them.
 *
 * Crucially, HOME is NOT overridden here — `cargo run` invokes rustup,
 * which reads $HOME/.rustup and $HOME/.cargo. Setting HOME to the
 * isolated dir made rustup try to download the toolchain into the run
 * directory and fail with "No such file or directory".
 * The agent's working dir is set via `default_working_dir` in its
 * fixture config instead.
 *
 * globalSetup runs BEFORE the webServer processes spawn; it creates the run
 * directory and registers the teardown that kills this run's tmux server.
 */

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFilePath}/{arg}-{platform}{ext}',

  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
      caret: 'hide',
    },
  },

  globalSetup: require.resolve('./globalSetup'),

  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },

  webServer: [
    {
      command: `cargo run -p nession-server -- ${__dirname}/fixtures/server/config.toml`,
      cwd: `${__dirname}/..`,
      env: {
        ...E2E_ISOLATION_ENV,
        RUST_LOG: 'info',  // Force logging to stdout
        RUST_BACKTRACE: '1',  // Enable backtraces for debugging
      },
      tcpPort: 19090,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      // Wait for server to be fully ready before starting agent
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Add a small delay to ensure server is fully ready
      command: `sleep 5 && cargo run -p nession-agent -- ${__dirname}/fixtures/agent-config.e2e.toml`,
      cwd: `${__dirname}/..`,
      env: {
        ...E2E_ISOLATION_ENV,
        // No TERM here on purpose: the agent must pin TERM=xterm-256color on
        // its own PTY attach clients (#633). CI runners export TERM=dumb or
        // nothing, so this env is the regression gate — a plain-mode attach
        // that forgets the pin dies with "terminal does not support clear".
        LANG: 'C.UTF-8',
        RUST_LOG: 'info',  // Force logging to stdout
        RUST_BACKTRACE: '1',  // Enable backtraces for debugging
      },
      tcpPort: 19091,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
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
