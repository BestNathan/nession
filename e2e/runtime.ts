import fs from 'node:fs';
import path from 'node:path';

const {
  acquirePortLease,
  createRunRoot,
  removeRunRoot,
  verifyRunRoot,
} = require('./runner/runtime/test-runtime.js');

/**
 * Compatibility profile for the regression E2E consumer of the shared
 * `acceptance/runtime/full-stack.mjs` harness.
 *
 * The harness owns lifecycle. This module owns the regression E2E run
 * identity: one short, ownership-verified Test Runtime root (#4597), a leased
 * port block, and the environment every Playwright worker and spawned child
 * inherits. Two independent runs can coexist because neither the root nor the
 * ports are fixed.
 *
 * Evaluation happens in the Playwright config process first; workers inherit
 * the exported environment and verify/reuse the same root instead of creating
 * a second one.
 */

const ROOT_ENV = 'NSESSION_E2E_RUN_ROOT';
const SERVER_PORT_ENV = 'NSESSION_E2E_SERVER_PORT';
const AGENT_PORT_ENV = 'NSESSION_E2E_AGENT_PORT';
const STALLED_PORT_ENV = 'NSESSION_E2E_STALLED_PROBE_PORT';
const WEB_PORT_ENV = 'NSESSION_E2E_WEB_PORT';

function positivePort(value, name) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(name + ' must be a TCP port; got ' + value);
  }
  return port;
}

function readPort(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      'inherited E2E runtime is missing ' + name + '; it was not published by the run owner (#4597)',
    );
  }
  return positivePort(value, name);
}

function publish(context) {
  process.env[ROOT_ENV] = context.root;
  process.env[SERVER_PORT_ENV] = String(context.serverPort);
  process.env[AGENT_PORT_ENV] = String(context.agentPort);
  process.env[STALLED_PORT_ENV] = String(context.stalledProbePort);
  process.env[WEB_PORT_ENV] = String(context.webPort);
  process.env.NESSION_TMUX_SOCKET = context.tmuxSocket;
  return context;
}

function createContext() {
  const created = createRunRoot('nession-e2e');
  const lease = acquirePortLease(created.root);
  const [serverPort, agentPort, stalledProbePort, webPort] = lease.ports;
  // A config-only load (`playwright test --list`, a failed early exit) never
  // starts the stack, so its root has no live resources worth keeping. A real
  // run sets NSESSION_E2E_RUNTIME_ACTIVE before provisioning and keeps its
  // root as evidence for the reaper.
  process.once('exit', () => {
    if (process.env.NSESSION_E2E_RUNTIME_ACTIVE === '1') return;
    try { removeRunRoot(created.root); } catch { /* leave for the reaper */ }
  });
  return publish({
    root: created.root,
    home: created.home,
    tmuxSocket: created.tmuxSocket,
    manifest: created.manifest,
    serverPort,
    agentPort,
    stalledProbePort,
    webPort,
  });
}

function inheritContext() {
  const verified = verifyRunRoot(process.env[ROOT_ENV]);
  return publish({
    root: verified.root,
    home: path.join(verified.root, 'home'),
    tmuxSocket: verified.manifest.tmux_socket,
    manifest: verified.manifest,
    serverPort: readPort(SERVER_PORT_ENV),
    agentPort: readPort(AGENT_PORT_ENV),
    stalledProbePort: readPort(STALLED_PORT_ENV),
    webPort: readPort(WEB_PORT_ENV),
  });
}

const context = process.env[ROOT_ENV] ? inheritContext() : createContext();

/** The ownership-verified run root. */
export const E2E_TEST_ROOT = context.root;

/** NESSION_HOME / working home for the regression run (inside the root). */
export const E2E_RUN_DIR = context.home;

/** Directory holding this run's isolated tmux socket. */
export const E2E_TMUX_DIR = path.dirname(context.tmuxSocket);

/** tmux socket for this E2E run. */
export const E2E_TMUX_SOCKET = context.tmuxSocket;

export const E2E_SERVER_PORT = context.serverPort;
export const E2E_AGENT_PORT = context.agentPort;
export const E2E_STALLED_PROBE_PORT = context.stalledProbePort;
export const E2E_WEB_PORT = context.webPort;
export const E2E_WEB_URL = `http://localhost:${E2E_WEB_PORT}`;
export const E2E_WEB_ORIGIN = E2E_WEB_URL;
export const E2E_SERVER_URL = `ws://localhost:${E2E_SERVER_PORT}/ws`;
export const E2E_AGENT_URL = `ws://127.0.0.1:${E2E_AGENT_PORT}/ws`;
export const E2E_STALLED_AGENT_URL = `ws://127.0.0.1:${E2E_STALLED_PROBE_PORT}/ws`;

/** Environment shared by the isolated Rust processes. */
export const E2E_ISOLATION_ENV = {
  NESSION_TMUX_SOCKET: E2E_TMUX_SOCKET,
  NESSION_HOME: path.join(E2E_RUN_DIR, '.nession'),
  NESSION_RUNTIME_DIR: path.join(E2E_TEST_ROOT, 'runtime'),
} as const;

// The config process creates the root before globalSetup; make sure the home
// directory the control file lives in exists for every importer.
fs.mkdirSync(E2E_RUN_DIR, { recursive: true, mode: 0o700 });
