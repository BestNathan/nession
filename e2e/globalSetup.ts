import { rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const E2E_RUN = '/tmp/nession-e2e';
const E2E_TMUX_SOCKET = '/tmp/nession-e2e/tmux';

/**
 * E2E global setup — runs once BEFORE the webServer processes spawn.
 *
 * Clears the isolated runtime directory (/tmp/nession-e2e) and kills any
 * tmux server that might still hold the socket from a prior aborted run.
 * After this returns, Playwright spawns the webServers, each of which
 * inherits the TMUX_TMPDIR / HOME / NESSION_HOME set in playwright.config.ts
 * and so lands in a fresh, isolated world.
 */
export default async function setup(): Promise<() => Promise<void>> {
  // ── Wipe the runtime directory ──────────────────────────────────────────
  // Recreate empty so tmux can write its socket there when the agent starts.
  rmSync(E2E_RUN, { recursive: true, force: true });

  // ── Kill any tmux server at the isolated socket ────────────────────────
  // Targets only the E2E socket path — never the user's real tmux.
  // Fails silently if no server is running.
  try {
    execSync(
      `TMUX_TMPDIR='${E2E_TMUX_SOCKET}' tmux kill-server`,
      { stdio: 'ignore' },
    );
  } catch {
    // no prior server — expected
  }

  // ── Teardown — runs AFTER Playwright has killed the webServer processes ─
  // Kill any Rust processes that may have survived (e.g. cargo spawned a
  // long-running child). Pattern targets only the E2E binary paths; it
  // cannot match ~/.local/bin/nession or any other installed binary.
  return async () => {
    for (const bin of ['nession-server', 'nession-agent']) {
      try {
        execSync(`pkill -f 'target/debug/${bin}'`, { stdio: 'ignore' });
      } catch {
        // no matching process — fine
      }
    }
  };
}
