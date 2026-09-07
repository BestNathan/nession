import { randomBytes } from 'node:crypto';

/**
 * Runtime paths for the e2e stack.
 *
 * Split into two, because the two halves want opposite lifetimes:
 *
 * - **`E2E_RUN_DIR`** (fixed) — NESSION_HOME: the server's SQLite db, log files,
 *   env files, and the agent's working dir. The fixture configs name this path
 *   literally (`e2e/fixtures/server/config.toml` → `db_path`), and globalSetup
 *   wipes it before each run so a run starts from known-empty state. Nothing
 *   here touches tmux, so wiping it is safe.
 *
 * - **`E2E_TMUX_SOCKET`** (unique per run) — the tmux socket, addressed by the
 *   Rust processes as an explicit `tmux -S <path>` via `$NESSION_TMUX_SOCKET`.
 *   Unique so two runs cannot see or kill each other's sessions, and cleaned up
 *   only in teardown: a *pre-run* `kill-server` on a fixed path is exactly the
 *   command that destroyed a developer's real tmux server (#574).
 *
 * `TMUX_TMPDIR` is deliberately not used anywhere: tmux ignores it whenever
 * `$TMUX` is set — i.e. whenever anything runs from inside a tmux session — and
 * then silently falls back to the default socket. `-S` is immune to `$TMUX`.
 *
 * The values are computed once and published through `process.env`, because
 * Playwright loads this module in more than one process and a module-level
 * random value would differ between them.
 *
 * Paths stay short on purpose: a unix socket path is capped near 104 bytes.
 */

const SOCKET_ENV = 'NESSION_TMUX_SOCKET';

/** NESSION_HOME for the run: db, logs, env files, agent working dir. */
export const E2E_RUN_DIR = '/tmp/nession-e2e';

/** Directory holding this run's tmux socket — sibling of E2E_RUN_DIR, so
 *  wiping that one never removes this one. */
export const E2E_TMUX_DIR = (() => {
  const existing = process.env[SOCKET_ENV];
  if (existing && existing.length > 0) {
    return existing.replace(/\/tmux\.sock$/, '');
  }
  return `/tmp/nession-e2e-tmux-${randomBytes(4).toString('hex')}`;
})();

/** tmux socket for this run — never shared with any other tmux server. */
export const E2E_TMUX_SOCKET = (() => {
  const existing = process.env[SOCKET_ENV];
  if (existing && existing.length > 0) {
    return existing;
  }
  const value = `${E2E_TMUX_DIR}/tmux.sock`;
  process.env[SOCKET_ENV] = value;
  return value;
})();

/** Environment every Rust process in this run is launched with. */
export const E2E_ISOLATION_ENV = {
  NESSION_TMUX_SOCKET: E2E_TMUX_SOCKET,
  NESSION_HOME: E2E_RUN_DIR,
} as const;
