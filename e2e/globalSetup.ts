import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { E2E_RUN_DIR, E2E_TMUX_DIR, E2E_TMUX_SOCKET } from './runtime';

/**
 * E2E global setup — runs once BEFORE the webServer processes spawn.
 *
 * Prepares two directories with deliberately different lifetimes (see
 * ./runtime.ts): the fixed NESSION_HOME, wiped so each run starts from empty
 * state, and this run's own tmux socket directory, which is never wiped
 * up-front.
 *
 * ── No pre-run tmux sweep ──────────────────────────────────────────────
 * Earlier versions ran `TMUX_TMPDIR=… tmux kill-server` here before starting.
 * That is gone, deliberately. `TMUX_TMPDIR` does not isolate anything once
 * `$TMUX` is set, so the command landed on the developer's default socket and
 * killed their real tmux server, sessions and all (#574). The socket path is now
 * unique per run, so there is no prior server of *this* run's to clean up.
 *
 * The cost is that a run killed hard (Ctrl-C / SIGKILL) never reaches the
 * teardown below, and its socket, tmux server and directory survive — and
 * because each run picks a new path, those orphans accumulate without bound
 * instead of being overwritten. Clean them up by hand with:
 *
 *   for s in /tmp/nession-e2e-tmux-*\/tmux.sock; do tmux -S "$s" kill-server; done
 *   rm -rf /tmp/nession-e2e-tmux-*
 *
 * A recovery tool for this is tracked in #582.
 *
 * ── Why not override HOME too? ─────────────────────────────────────────
 * `cargo run` invokes rustup, which reads `$HOME/.rustup` and `$HOME/.cargo`.
 * Setting HOME to the isolated dir made rustup try to download the toolchain
 * into /tmp/nession-e2e/.rustup and fail with "No such file or directory". The
 * agent's working dir is set via `default_working_dir` in its fixture config
 * instead.
 */
export default async function setup(): Promise<() => Promise<void>> {
  // ── NESSION_HOME: wipe, then recreate empty ─────────────────────────────
  // Holds only on-disk state (SQLite db, logs, env files) and the agent's
  // working dir — no tmux socket lives here, which is what makes wiping safe.
  rmSync(E2E_RUN_DIR, { recursive: true, force: true });
  mkdirSync(E2E_RUN_DIR, { recursive: true });

  // ── This run's tmux socket directory ────────────────────────────────────
  // tmux does not create the socket's parent directory (measured: it fails with
  // "error creating <path> (No such file or directory)"), so create it here.
  mkdirSync(E2E_TMUX_DIR, { recursive: true, mode: 0o700 });

  return async () => {
    // ── Kill this run's tmux server ────────────────────────────────────
    // Targeted by absolute socket path, and only after the server on it
    // confirms that same path — so this can never reach another server.
    if (existsSync(E2E_TMUX_SOCKET)) {
      try {
        const reported = execFileSync(
          'tmux',
          ['-S', E2E_TMUX_SOCKET, 'display-message', '-p', '#{socket_path}'],
          { encoding: 'utf8' },
        ).trim();
        if (reported === E2E_TMUX_SOCKET) {
          execFileSync('tmux', ['-S', E2E_TMUX_SOCKET, 'kill-server'], {
            stdio: 'ignore',
          });
        } else {
          console.warn(
            `[e2e teardown] refusing kill-server: socket reported ${reported}, expected ${E2E_TMUX_SOCKET}`,
          );
        }
      } catch {
        // No server on the socket — it already exited (tmux's exit-empty
        // closes the server once the last session goes).
      }
    }

    // ── Kill Rust processes that survived the webServer shutdown ────────
    // Pattern targets only the E2E binary paths; it cannot match
    // ~/.local/bin/nession or any other installed binary.
    for (const bin of ['nession-server', 'nession-agent']) {
      try {
        execFileSync('pkill', ['-f', `target/debug/${bin}`], { stdio: 'ignore' });
      } catch {
        // no matching process — fine
      }
    }

    rmSync(E2E_TMUX_DIR, { recursive: true, force: true });
  };
}
