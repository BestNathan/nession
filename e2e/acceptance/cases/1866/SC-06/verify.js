'use strict';
// #1866 SC-06 (narrowed to its executable range, owner decision 2026-10-17):
// failure, partial start, timeout and cancellation/stop perform bounded
// OWNED-resource cleanup, never touch foreign processes or paths, and a timed
// out verifier is Error, never a fabricated Pass.
//
// Every assertion below runs the real runtime harness or the real verifier
// driver. The workflow-level cancellation/retry clauses were explicitly moved
// out of this criterion because they are not observable from a Case.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const {
  allocateLoopbackPort,
  startFullStackRuntime,
} = require(path.join(REPO_ROOT, 'e2e/runner/runtime/full-stack.js'));
const {
  createRunRoot,
  removeRunRoot,
} = require(path.join(REPO_ROOT, 'e2e/runner/runtime/test-runtime.js'));
const { executeVerifier } = require(path.join(REPO_ROOT, 'e2e/runner/drivers/index.mjs'));

const TARGET = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
const evidence = [];

function ownedRoot(label) {
  return createRunRoot('nession-sc06-' + label);
}
function ownedHome(root) {
  return path.join(root, 'home');
}
function ownedSocket(root) {
  return path.join(root, 'sockets', 'tmux.sock');
}
async function ports() {
  return Promise.all([allocateLoopbackPort(), allocateLoopbackPort(),
    allocateLoopbackPort(), allocateLoopbackPort()]);
}
function portAccepts(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}
async function occupy(port) {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
async function stopServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  assert.match(String(TARGET || ''), /^[0-9a-f]{40}$/);

  // 1. A path outside the verified run root is rejected before anything is
  // spawned or created. A symlink inside the owned root is the hostile shape:
  // it must not escape to the foreign directory.
  const foreignRun = ownedRoot('foreign');
  const foreignHome = path.join(os.tmpdir(), 'foreign-runtime-' + process.pid);
  const link = path.join(foreignRun.root, 'home-link');
  fs.symlinkSync(foreignHome, link);
  const [s1, a1, p1, w1] = await ports();
  try {
    await assert.rejects(() => startFullStackRuntime({
      repoRoot: REPO_ROOT, targetSha: TARGET, webOnly: true,
      runRoot: foreignRun.root, home: link, tmuxSocket: ownedSocket(foreignRun.root),
      serverPort: s1, agentPort: a1, stalledProbePort: p1, webPort: w1,
      cleanupHome: true, cleanupRoot: true,
    }), /outside this run's Test Runtime root/);
  } finally {
    removeRunRoot(foreignRun.root);
  }
  assert.equal(fs.existsSync(foreignHome), false, 'foreign path must stay untouched');
  evidence.push({ type: 'runtime', value: 'foreign runtime path rejected before provisioning' });

  // 2. Partial start: an occupied web port makes the preview die before
  //    readiness; the failure path must reap its whole owned run root.
  const partialRun = ownedRoot('partial');
  const partialHome = ownedHome(partialRun.root);
  const partialSocket = ownedSocket(partialRun.root);
  const partialDir = path.dirname(partialSocket);
  const [s2, a2, p2, w2] = await ports();
  const blocker = await occupy(w2);
  try {
    await assert.rejects(() => startFullStackRuntime({
      repoRoot: REPO_ROOT, targetSha: TARGET, webOnly: true,
      runRoot: partialRun.root, home: partialHome, tmuxSocket: partialSocket,
      serverPort: s2, agentPort: a2, stalledProbePort: p2, webPort: w2,
      cleanupHome: true, cleanupRoot: true,
    }));
  } finally {
    await stopServer(blocker);
  }
  assert.equal(fs.existsSync(partialHome), false, 'failed start must remove its owned home');
  assert.equal(fs.existsSync(partialDir), false, 'failed start must remove its owned socket directory');
  assert.equal(fs.existsSync(partialRun.root), false, 'failed start must remove its owned run root');
  evidence.push({ type: 'runtime', value: 'partial start rejected and removed its own home/socket paths' });

  // 3. Normal cancellation/stop: a real web-only runtime becomes ready, is
  //    stopped, and its owned paths plus listener are gone. A foreign sleeper
  //    started before the cycle must survive.
  const foreign = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
  });
  try {
    const stopRun = ownedRoot('stop');
    const home = ownedHome(stopRun.root);
    const socket = ownedSocket(stopRun.root);
    const tmuxDir = path.dirname(socket);
    const [s3, a3, p3, w3] = await ports();
    const runtime = await startFullStackRuntime({
      repoRoot: REPO_ROOT, targetSha: TARGET, webOnly: true,
      runRoot: stopRun.root, home, tmuxSocket: socket,
      serverPort: s3, agentPort: a3, stalledProbePort: p3, webPort: w3,
      cleanupHome: true, cleanupRoot: true,
    });
    const response = await fetch(runtime.base_url, { redirect: 'manual' });
    assert.ok(response.status < 500, 'web-only runtime must be ready');
    await runtime.stop();
    assert.equal(fs.existsSync(home), false, 'stop must remove its owned home');
    assert.equal(fs.existsSync(tmuxDir), false, 'stop must remove its owned socket directory');
    assert.equal(fs.existsSync(stopRun.root), false, 'stop must remove its owned run root');
    assert.equal(await portAccepts(w3), false, 'stop must close the owned preview port');
    assert.doesNotThrow(() => process.kill(foreign.pid, 0),
      'a foreign process must survive an owned runtime stop');
    evidence.push({ type: 'runtime', value: 'owned runtime stop closed its port and removed its paths; foreign process survived' });
  } finally {
    try { foreign.kill('SIGKILL'); } catch { /* already gone */ }
  }

  // 4. A timed-out verifier is Error with infrastructure_error=timeout, never
  //    a fabricated Pass.
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-sc06-timeout-'));
  const runtimeFile = path.join(caseDir, 'runtime.json');
  fs.writeFileSync(runtimeFile, '{}\n');
  fs.writeFileSync(path.join(caseDir, 'sleep.js'),
    'setTimeout(() => process.exit(0), 5000);\n');
  try {
    const result = await executeVerifier({ type: 'runtime', entry: 'sleep.js' }, {
      repoRoot: REPO_ROOT, caseDir, runtimeFile, baseURL: '',
      targetSha: TARGET, contractSha256: 'c'.repeat(64),
      issueNumber: 1866, criterion: 'SC-06', timeoutMs: 500,
    });
    assert.equal(result.result, 'Error', 'a timed-out verifier must not Pass');
    assert.equal(result.infrastructure_error, 'timeout');
    evidence.push({ type: 'runtime', value: 'verifier timeout returned Error/timeout instead of Pass' });
  } finally {
    fs.rmSync(caseDir, { recursive: true, force: true });
  }

  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary: 'Owned-resource cleanup is bounded on partial start and stop, foreign paths/processes ' +
      'are untouched, and a timed-out verifier is Error rather than Pass.',
    evidence,
  }) + '\n');
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(message + '\n');
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: message,
    evidence: [{ type: 'runtime', value: 'SC-06 owned-resource cleanup contract failed' }],
  }) + '\n');
  process.exitCode = 1;
});
