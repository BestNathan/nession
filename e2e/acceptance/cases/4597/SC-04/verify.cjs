'use strict';
// SC-04 (#4597): the E2E/Acceptance runner allocates unique roots and port
// leases and publishes a run manifest. Two independent runs coexist; stopping
// one does not affect the other; a forged/inherited/foreign path is rejected
// before any process or deletion, and the browser session lifecycle remains the
// regression lane's proof (E2E Report: session-lifecycle).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const {
  allocateLoopbackPort,
  startFullStackRuntime,
} = require(path.join(REPO_ROOT, 'e2e/runner/runtime/full-stack.js'));
const {
  createRunRoot,
  removeRunRoot,
  verifyRunRoot,
} = require(path.join(REPO_ROOT, 'e2e/runner/runtime/test-runtime.js'));

const TARGET = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
const evidence = [];

function pidOf(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim());
  } catch {
    return null;
  }
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

async function startPair(label) {
  const run = createRunRoot('nession-4597-' + label);
  const ports = await Promise.all([
    allocateLoopbackPort(), allocateLoopbackPort(), allocateLoopbackPort(), allocateLoopbackPort(),
  ]);
  const runtime = await startFullStackRuntime({
    repoRoot: REPO_ROOT,
    targetSha: TARGET,
    profile: 'full-stack-local',
    runRoot: run.root,
    home: path.join(run.root, 'home'),
    tmuxSocket: run.tmux_socket,
    serverPort: ports[0],
    agentPort: ports[1],
    stalledProbePort: ports[2],
    webPort: ports[3],
    cleanupHome: true,
    cleanupRoot: true,
  });
  return { run, ports, runtime };
}

async function main() {
  assert.match(String(TARGET || ''), /^[0-9a-f]{40}$/);

  // A forged/foreign root is refused before provisioning or deletion.
  const forged = createRunRoot('nession-4597-forged');
  const foreignHome = path.join(require('node:os').tmpdir(), 'foreign-4597-' + process.pid);
  const link = path.join(forged.root, 'home-link');
  fs.symlinkSync(foreignHome, link);
  const [s0, a0, p0, w0] = await Promise.all([
    allocateLoopbackPort(), allocateLoopbackPort(), allocateLoopbackPort(), allocateLoopbackPort(),
  ]);
  await assert.rejects(() => startFullStackRuntime({
    repoRoot: REPO_ROOT,
    targetSha: TARGET,
    profile: 'full-stack-local',
    runRoot: forged.root,
    home: link,
    tmuxSocket: forged.tmux_socket,
    serverPort: s0, agentPort: a0, stalledProbePort: p0, webPort: w0,
    cleanupHome: true, cleanupRoot: true,
  }), /outside this run's Test Runtime root/);
  assert.equal(fs.existsSync(foreignHome), false, 'the foreign target must stay untouched');

  const tampered = createRunRoot('nession-4597-tampered');
  const manifestPath = path.join(tampered.root, 'manifest.json');
  const original = fs.readFileSync(manifestPath, 'utf8');
  fs.writeFileSync(manifestPath, original.replace(tampered.root, '/tmp/not-this-run'));
  assert.throws(() => verifyRunRoot(tampered.root), /does not name|names root/);
  fs.writeFileSync(manifestPath, original);
  removeRunRoot(tampered.root);
  removeRunRoot(forged.root);
  evidence.push({
    type: 'negative',
    value: 'symlink-escape home and a tampered manifest were rejected before provisioning; foreign path untouched',
  });

  // Two independent runs coexist with distinct roots, sockets, manifests and
  // port leases.
  const a = await startPair('a');
  const b = await startPair('b');
  let aStopped = false;
  try {
    const responseA = await fetch(a.runtime.base_url, { redirect: 'manual' });
    const responseB = await fetch(b.runtime.base_url, { redirect: 'manual' });
    assert.ok(responseA.status < 500, 'run A preview is not ready');
    assert.ok(responseB.status < 500, 'run B preview is not ready');
    assert.notEqual(a.run.root, b.run.root, 'two runs shared a root');
    assert.notEqual(a.runtime.tmux_socket, b.runtime.tmux_socket, 'two runs shared a tmux socket');
    for (const [name, pair] of [['A', a], ['B', b]]) {
      const verified = verifyRunRoot(pair.run.root);
      assert.equal(verified.manifest.lifecycle, 'active');
      const metadata = JSON.parse(
        fs.readFileSync(path.join(pair.run.root, 'home', 'runtime.json'), 'utf8'),
      );
      assert.equal(metadata.run_root, verified.root, name + ' runtime.json does not name its root');
      assert.equal(metadata.run_id, verified.manifest.run_id, name + ' runtime.json run_id mismatch');
      assert.ok(pidOf(path.join(pair.run.root, 'runtime', 'server.pid')), name + ' has no Server PID');
      assert.ok(pidOf(path.join(pair.run.root, 'runtime', 'agent.pid')), name + ' has no Agent PID');
    }
    const bServerPid = pidOf(path.join(b.run.root, 'runtime', 'server.pid'));
    const bAgentPid = pidOf(path.join(b.run.root, 'runtime', 'agent.pid'));

    // Stopping A removes only A's owned root and closes only A's preview port.
    await a.runtime.stop();
    aStopped = true;
    assert.equal(fs.existsSync(a.run.root), false, 'stopped run A left its root behind');
    assert.equal(await portAccepts(a.ports[3]), false, 'stopped run A left its web port open');
    assert.equal(await portAccepts(b.ports[3]), true, 'run B lost readiness when A stopped');
    assert.equal(pidOf(path.join(b.run.root, 'runtime', 'server.pid')), bServerPid,
      'run B Server PID changed when A stopped');
    assert.equal(pidOf(path.join(b.run.root, 'runtime', 'agent.pid')), bAgentPid,
      'run B Agent PID changed when A stopped');
    const responseB2 = await fetch(b.runtime.base_url, { redirect: 'manual' });
    assert.ok(responseB2.status < 500, 'run B preview stopped responding after A stopped');

    evidence.push({
      type: 'runtime',
      value: 'two concurrent runs: roots ' + a.run.root + ' and ' + b.run.root +
        ', distinct sockets and leased ports; A stopped and removed only its own root/port while B ' +
        '(server pid ' + bServerPid + ', agent pid ' + bAgentPid + ') stayed ready',
    });
    return {
      status: 'pass',
      summary: 'Unique roots/ports/manifests allow two concurrent runs; stopping one leaves the ' +
        'other ready; forged/symlinked/foreign paths are rejected before provisioning (exact SHA ' +
        TARGET + '); browser session lifecycle is the E2E Report regression lane',
      evidence,
    };
  } finally {
    if (!aStopped) {
      try { await a.runtime.stop(); } catch { /* reaper owns verified leftovers */ }
    }
    try { await b.runtime.stop(); } catch { /* reaper owns verified leftovers */ }
  }
}

main().then((result) => {
  process.stdout.write(JSON.stringify(result) + '\n');
}).catch((error) => {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: error instanceof Error ? error.message : String(error),
    evidence,
  }) + '\n');
  process.exitCode = 1;
});
