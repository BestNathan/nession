import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const { startFullStackRuntime } = require('./runner/runtime/full-stack.js');
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
 * Where the worker-visible control plane publishes its loopback port and the
 * per-run token. A file rather than an environment variable because Playwright
 * workers are separate processes and do not inherit variables assigned here.
 */
const CONTROL_FILE = path.join(E2E_RUN_DIR, 'runtime-control.json');

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
    // #1866 SC-01: the design-system browser profile renders client-side
    // fixtures, so it only needs the built web preview. Every other caller
    // keeps the full Server/Agent/tmux stack.
    webOnly: process.env.E2E_RUNTIME_WEB_ONLY === '1',
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

  // The Agent-restart fixture (#1926 SC-05) needs a fault the browser cannot
  // produce itself: the harness owns the process, and this setup process owns
  // the harness. Workers cannot receive the harness object, so they reach it
  // through this loopback control plane. It is token-gated, bound to 127.0.0.1,
  // exists only while this run is alive, and is removed with the run.
  const controlToken = randomBytes(16).toString('hex');
  const control = http.createServer(async (request, response) => {
    const authorized = request.method === 'POST'
      && request.url === '/restart-agent'
      && request.headers['x-e2e-control'] === controlToken;
    if (!authorized) {
      response.writeHead(404).end();
      return;
    }
    try {
      const result = await runtime.restartAgent();
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      response
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: false, error: String(error) }));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      control.once('error', reject);
      control.listen(0, '127.0.0.1', () => resolve());
    });
    const address = control.address();
    if (address === null || typeof address === 'string') {
      throw new Error('E2E runtime control plane did not bind a loopback port');
    }
    fs.mkdirSync(E2E_RUN_DIR, { recursive: true });
    fs.writeFileSync(
      CONTROL_FILE,
      JSON.stringify({ port: address.port, token: controlToken }, null, 2) + '\n',
    );
  } catch (error) {
    control.close();
    await runtime.stop();
    throw error;
  }

  return async () => {
    await new Promise<void>((resolve) => control.close(() => resolve()));
    fs.rmSync(CONTROL_FILE, { force: true });
    await runtime.stop();
  };
}
