import { defineConfig } from '@playwright/test';

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
 * The agent's tmux commands use the system tmux socket at
 * $TMUX_TMPDIR/tmux-<uid>/default (default: /tmp/tmux-<uid>/default).
 * Without isolation the E2E agent would share a tmux server with the
 * developer's real tmux — session names collide, env files leak in, and
 * `create` fails silently whenever a leftover from a previous run has
 * the same name.
 *
 * webServer.env below forces TMUX_TMPDIR + NESSION_HOME to live under
 * /tmp/nession-e2e. Every Rust process the config spawns uses an
 * isolated tmux socket, and the server's env-files lookup (driven by
 * NESSION_HOME, not HOME) and explicit db_path (/tmp/nession-e2e/nession.db)
 * cover the on-disk state.
 *
 * Crucially, HOME is NOT overridden here — `cargo run` invokes rustup,
 * which reads $HOME/.rustup and $HOME/.cargo. Setting HOME to the
 * isolated dir made rustup try to download the toolchain into
 * /tmp/nession-e2e/.rustup and fail with "No such file or directory".
 * The agent's working dir is set via `default_working_dir` in its
 * fixture config instead.
 *
 * globalSetup runs BEFORE the webServer processes spawn, so it clears
 * the runtime directory and kills any tmux server that might still hold
 * the socket from a prior aborted run.
 */

const E2E_RUN = '/tmp/nession-e2e';
const E2E_TMUX_SOCKET = '/tmp/nession-e2e/tmux';

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',

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
        TMUX_TMPDIR: E2E_TMUX_SOCKET,
        NESSION_HOME: E2E_RUN,
        RUST_LOG: 'info',  // Force logging to stdout
        RUST_BACKTRACE: '1',  // Enable backtraces for debugging
      },
      tcpPort: 19090,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `cargo run -p nession-agent -- ${__dirname}/fixtures/agent-config.e2e.toml`,
      cwd: `${__dirname}/..`,
      env: {
        TMUX_TMPDIR: E2E_TMUX_SOCKET,
        NESSION_HOME: E2E_RUN,
        RUST_LOG: 'info',  // Force logging to stdout
        RUST_BACKTRACE: '1',  // Enable backtraces for debugging
      },
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
