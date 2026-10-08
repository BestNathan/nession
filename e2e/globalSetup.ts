import path from 'node:path';

const { startFullStackRuntime } = require('../acceptance/runtime/full-stack.js');
import {
  E2E_AGENT_PORT,
  E2E_RUN_DIR,
  E2E_SERVER_PORT,
  E2E_STALLED_PROBE_PORT,
  E2E_TMUX_SOCKET,
  E2E_WEB_PORT,
  E2E_WEB_URL,
} from './runtime';

/**
 * Regression E2E is a consumer of the shared full-stack Runtime Harness.
 *
 * Playwright no longer owns Server / Agent / tmux / Web provisioning. Its
 * global setup asks the same harness used by Acceptance to provision the real
 * stack, and returns the harness teardown. That keeps regression E2E lifecycle
 * independent from Acceptance lifecycle while sharing the low-level runtime.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const runtime = await startFullStackRuntime({
    repoRoot: path.resolve(__dirname, '..'),
    targetSha: process.env.NESSION_TARGET_SHA,
    profile: 'e2e-regression',
    home: E2E_RUN_DIR,
    tmuxSocket: E2E_TMUX_SOCKET,
    serverPort: E2E_SERVER_PORT,
    agentPort: E2E_AGENT_PORT,
    stalledProbePort: E2E_STALLED_PROBE_PORT,
    webPort: E2E_WEB_PORT,
    // Preserve the old regression-run artifact/debug lifetime: the next run
    // wipes NESSION_HOME before provisioning, while teardown always removes
    // processes and this run's isolated tmux server/socket.
    cleanupHome: false,
  });

  if (runtime.base_url !== E2E_WEB_URL) {
    await runtime.stop();
    throw new Error(
      `E2E runtime URL mismatch: harness returned ${runtime.base_url}, expected ${E2E_WEB_URL}`,
    );
  }

  return async () => {
    await runtime.stop();
  };
}
