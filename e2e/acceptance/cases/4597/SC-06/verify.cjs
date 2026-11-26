'use strict';
// SC-06 (#4597): normal completion, panic, failed partial startup, timeout,
// SIGTERM and SIGKILL of a disposable run leave no live owned resources after
// bounded teardown. The reaper proves run ownership: it reclaims a dead
// verified root, never a live root and never an unverified look-alike.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
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
  verifyRunRoot,
} = require(path.join(REPO_ROOT, 'e2e/runner/runtime/test-runtime.js'));

const TARGET = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
const SWEEP = path.join(REPO_ROOT, 'scripts/sweep-test-sessions.sh');
const TEST_RUNTIME = path.join(REPO_ROOT, 'scripts/test-runtime.sh');
const evidence = [];

function portAccepts(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

function waitForLine(child) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk;
      const line = buffer.split('\n').find((value) => value.trim());
      if (line) {
        child.stdout.off('data', onData);
        resolve(line.trim());
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.once('error', reject);
  });
}

function spawnHelper() {
  const script = [
    '. "$1"',
    'nession_test_runtime_init',
    'trap "nession_test_runtime_cleanup" EXIT INT TERM',
    'printf "%s\\n" "$NSESSION_TEST_RUNTIME_DIR"',
    'sleep 60 & wait $!',
  ].join('\n');
  return spawn('bash', ['-c', script, 'bash', TEST_RUNTIME], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
}

async function waitExit(child, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('helper did not exit in time')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function sweepKill() {
  try {
    return {
      status: 0,
      output: require('node:child_process').execFileSync(SWEEP, ['--kill'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 120000,
      }),
    };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      output: String(error.stdout || '') + String(error.stderr || ''),
    };
  }
}

async function main() {
  assert.match(String(TARGET || ''), /^[0-9a-f]{40}$/);

  // 1. Normal completion: bounded stop removes the owned root and closes the
  //    preview listener.
  const normal = createRunRoot('nession-4597-normal');
  const [s1, a1, p1, w1] = await Promise.all([
    allocateLoopbackPort(), allocateLoopbackPort(), allocateLoopbackPort(), allocateLoopbackPort(),
  ]);
  const runtime = await startFullStackRuntime({
    repoRoot: REPO_ROOT,
    targetSha: TARGET,
    profile: 'web-only',
    webOnly: true,
    runRoot: normal.root,
    home: path.join(normal.root, 'home'),
    tmuxSocket: normal.tmux_socket,
    serverPort: s1, agentPort: a1, stalledProbePort: p1, webPort: w1,
    cleanupHome: true,
    cleanupRoot: true,
  });
  const response = await fetch(runtime.base_url, { redirect: 'manual' });
  assert.ok(response.status < 500, 'web-only runtime is not ready');
  const startedStop = Date.now();
  await runtime.stop();
  const stopMs = Date.now() - startedStop;
  assert.ok(stopMs < 60000, 'normal teardown exceeded its bound: ' + stopMs + 'ms');
  assert.equal(fs.existsSync(normal.root), false, 'normal stop left its owned root');
  assert.equal(await portAccepts(w1), false, 'normal stop left its preview port open');
  evidence.push({
    type: 'runtime',
    value: 'normal completion: owned root removed, preview port closed, teardown ' + stopMs + 'ms',
  });

  // 2. Failed partial startup: an occupied web port must still reap the root.
  const partial = createRunRoot('nession-4597-partial');
  const [s2, a2, p2, w2] = await Promise.all([
    allocateLoopbackPort(), allocateLoopbackPort(), allocateLoopbackPort(), allocateLoopbackPort(),
  ]);
  const blocker = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(w2, '127.0.0.1', resolve);
  });
  try {
    await assert.rejects(() => startFullStackRuntime({
      repoRoot: REPO_ROOT,
      targetSha: TARGET,
      profile: 'web-only',
      webOnly: true,
      runRoot: partial.root,
      home: path.join(partial.root, 'home'),
      tmuxSocket: partial.tmux_socket,
      serverPort: s2, agentPort: a2, stalledProbePort: p2, webPort: w2,
      cleanupHome: true, cleanupRoot: true,
    }));
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
  assert.equal(fs.existsSync(partial.root), false, 'failed partial start left its owned root');
  evidence.push({
    type: 'runtime',
    value: 'failed partial startup: occupied web port rejected; owned root removed',
  });

  // 3. SIGTERM: the helper's EXIT/INT/TERM trap proves ownership and removes
  //    the root.
  const termHelper = spawnHelper();
  const termRoot = await waitForLine(termHelper);
  assert.ok(termRoot.startsWith('/tmp/nession-test-runtime.') ||
    termRoot.startsWith('/private/tmp/nession-test-runtime.'), 'unexpected helper root: ' + termRoot);
  process.kill(-termHelper.pid, 'SIGTERM');
  const termExit = await waitExit(termHelper, 20000).catch(() => null);
  assert.ok(termExit, 'SIGTERM helper did not exit');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fs.existsSync(termRoot), false, 'SIGTERM teardown left the root');
  evidence.push({
    type: 'runtime',
    value: 'SIGTERM: trap removed ' + termRoot + ' (signal ' + termExit.signal + ')',
  });

  // 4. SIGKILL: no trap can run; the verified root survives and the reaper
  //    reclaims it. A live root and an unverified look-alike must survive.
  const killHelper = spawnHelper();
  const killRoot = await waitForLine(killHelper);
  process.kill(-killHelper.pid, 'SIGKILL');
  await waitExit(killHelper, 20000).catch(() => null);
  assert.equal(fs.existsSync(killRoot), true, 'SIGKILL cannot have cleaned the root itself');
  // verifyRunRoot requires a live owner; the reaper reads the manifest directly.
  const killManifest = JSON.parse(fs.readFileSync(path.join(killRoot, 'manifest.json'), 'utf8'));
  assert.equal(killManifest.lifecycle, 'active');

  const liveHelper = spawnHelper();
  const liveRoot = await waitForLine(liveHelper);
  const forgedRoot = '/tmp/nession-test-runtime.forged-' + process.pid + '-' + Date.now();
  fs.mkdirSync(forgedRoot, { mode: 0o700 });
  try {
    const swept = sweepKill();
    assert.equal(fs.existsSync(killRoot), false, 'the reaper did not reclaim a dead verified root');
    assert.equal(fs.existsSync(liveRoot), true, 'the reaper touched a live root');
    assert.equal(fs.existsSync(forgedRoot), true, 'the reaper deleted an unverified look-alike');
    assert.match(swept.output, /unverified/,
      'the reaper must report an unverified directory: ' + swept.output.slice(-1200));
    evidence.push({
      type: 'runtime',
      value: 'SIGKILL: dead verified root ' + killRoot + ' reclaimed; live ' + liveRoot +
        ' untouched; unverified look-alike refused',
    });
  } finally {
    try { process.kill(-liveHelper.pid, 'SIGTERM'); } catch { /* already gone */ }
    await waitExit(liveHelper, 20000).catch(() => null);
    fs.rmSync(forgedRoot, { recursive: true, force: true });
  }

  // 5. Panic and timeout: a child that creates a root and dies without a trap
  //    leaves it for the reaper, which proves the dead owner.
  for (const [name, body] of [
    ['panic', 'process.exit(101)'],
    ['timeout', 'setInterval(() => {}, 1000)'],
  ]) {
    const child = spawn(process.execPath, ['-e', [
      'const rt = require(' + JSON.stringify(path.join(REPO_ROOT, 'e2e/runner/runtime/test-runtime.js')) + ');',
      'const run = rt.createRunRoot("nession-4597-' + name + '");',
      'process.stdout.write(run.root + "\\n");',
      body + ';',
    ].join('\n')], { stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
    const root = await waitForLine(child);
    if (name === 'timeout') {
      await new Promise((resolve) => setTimeout(resolve, 50));
      child.kill('SIGKILL');
    }
    await waitExit(child, 10000).catch(() => null);
    assert.equal(fs.existsSync(root), true, name + ' child unexpectedly cleaned its root');
    sweepKill();
    assert.equal(fs.existsSync(root), false, name + ' root was not reclaimed after the owner died');
    evidence.push({
      type: 'runtime',
      value: name + ': child root ' + root + ' survived the abnormal exit and was reclaimed by the reaper',
    });
  }

  return {
    status: 'pass',
    summary: 'Normal/partial/panic/timeout/SIGTERM/SIGKILL teardown leaves no live owned resource; ' +
      'the reaper reclaims only dead verified roots and refuses live/foreign ones (exact SHA ' +
      TARGET + ')',
    evidence,
  };
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
