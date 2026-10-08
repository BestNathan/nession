import { randomBytes } from 'node:crypto';

/**
 * Compatibility profile for the regression E2E consumer of the shared
 * `acceptance/runtime/full-stack.mjs` harness.
 *
 * The harness owns lifecycle. This module only owns the E2E profile values that
 * are intentionally kept stable so the existing regression corpus and visual
 * baselines do not change while lifecycle ownership moves out of Playwright.
 *
 * Acceptance Cases may supply different per-run homes, sockets and ports to the
 * same harness without importing Playwright.
 */

const SOCKET_ENV = 'NESSION_TMUX_SOCKET';

/** NESSION_HOME for the regression E2E run. */
export const E2E_RUN_DIR = '/tmp/nession-e2e';

/** Directory holding this run's isolated tmux socket. */
export const E2E_TMUX_DIR = (() => {
  const existing = process.env[SOCKET_ENV];
  if (existing && existing.length > 0) {
    return existing.replace(/\/tmux\.sock$/, '');
  }
  return `/tmp/nession-e2e-tmux-${randomBytes(4).toString('hex')}`;
})();

/** tmux socket for this E2E run, published so every spawned process agrees. */
export const E2E_TMUX_SOCKET = (() => {
  const existing = process.env[SOCKET_ENV];
  if (existing && existing.length > 0) {
    return existing;
  }
  const value = `${E2E_TMUX_DIR}/tmux.sock`;
  process.env[SOCKET_ENV] = value;
  return value;
})();

export const E2E_SERVER_PORT = 19090;
export const E2E_AGENT_PORT = 19091;
export const E2E_STALLED_PROBE_PORT = 19092;
export const E2E_WEB_PORT = 4173;
export const E2E_WEB_URL = `http://localhost:${E2E_WEB_PORT}`;

/** Environment shared by the isolated Rust processes. */
export const E2E_ISOLATION_ENV = {
  NESSION_TMUX_SOCKET: E2E_TMUX_SOCKET,
  NESSION_HOME: E2E_RUN_DIR,
} as const;
