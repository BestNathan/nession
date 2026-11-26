'use strict';
// SC-02 (#4597): real-tmux/Agent tests use owned socket, metadata, binding and
// shell roots. A second real Agent on its own socket creates, mutates and
// cleans Sessions without changing the first Agent's server/Agent PID, socket,
// configuration/state hashes or tmux Session/pane identity.
//
// The fail-closed Cargo-test guard itself is the #4596 regression proven by the
// PR-stage Rust tests; this Case proves the owned-runtime boundary that guard
// protects, against real binaries on this staging SHA.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const {
  allocateLoopbackPort,
  startFullStackRuntime,
} = require(path.join(REPO_ROOT, 'e2e/runner/runtime/full-stack.js'));
const {
  createRunRoot,
  sanitizedEnv,
  verifyRunRoot,
} = require(path.join(REPO_ROOT, 'e2e/runner/runtime/test-runtime.js'));

const TARGET = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
const RUNTIME_FILE = process.env.NESSION_ACCEPTANCE_RUNTIME_FILE;
const evidence = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walkFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return out.sort();
}

function stateFingerprint(home) {
  // Configuration, identity and binding state — not logs or the live DB/WAL,
  // which a heartbeat may legitimately touch while both runs are up.
  const files = {};
  const roots = [
    path.join(home, 'runtime-config'),
    path.join(home, '.nession', 'agent', 'claude'),
    path.join(home, '.nession', 'agent', 'env-bindings'),
    path.join(home, '.nession', 'server', 'envs'),
  ];
  for (const root of roots) {
    for (const file of walkFiles(root)) {
      files[path.relative(home, file)] = sha256(file);
    }
  }
  const identity = path.join(home, '.nession', 'agent', 'identity');
  if (fs.existsSync(identity)) files['identity'] = sha256(identity);
  return files;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tmuxPanes(socket) {
  try {
    return execFileSync(
      'tmux',
      ['-S', socket, 'list-panes', '-a', '-F',
        '#{session_name}:#{session_id}:#{window_id}:#{pane_id}:#{pane_pid}'],
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean).sort();
  } catch {
    return [];
  }
}

function cliInvocation() {
  const built = path.join(REPO_ROOT, 'target', 'debug', 'nession');
  return fs.existsSync(built)
    ? { command: built, args: [] }
    : { command: 'cargo', args: ['run', '-p', 'nession-cli', '--'] };
}

function cliOutput(invocation, args, env, timeout = 60000) {
  try {
    const stdout = execFileSync(invocation.command, [...invocation.args, ...args], {
      cwd: REPO_ROOT, env, encoding: 'utf8', timeout,
    });
    return { status: 0, output: stdout };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      output: String(error.stdout || '') + String(error.stderr || ''),
    };
  }
}

async function main() {
  assert.match(String(TARGET || ''), /^[0-9a-f]{40}$/);
  assert.ok(RUNTIME_FILE, 'the evaluator must provide a runtime file');
  const provided = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  const providedRoot = verifyRunRoot(provided.run_root);
  const homeA = provided.home;
  const socketA = provided.tmux_socket;
  assert.ok(homeA.startsWith(providedRoot.root + path.sep), 'runtime home is outside its root');
  assert.ok(socketA.startsWith(providedRoot.root + path.sep), 'tmux socket is outside its root');

  const identityA = fs.readFileSync(path.join(homeA, '.nession', 'agent', 'identity'), 'utf8').trim();
  assert.ok(identityA, 'the provided runtime minted no Agent identity');

  // A first creates and holds its own real Session: B must not perturb its
  // Pane identity, not merely an empty server.
  const binA = cliInvocation();
  const envA = sanitizedEnv(providedRoot.root, socketA, { NESION_NO_UPDATE_CHECK: '1' });
  const serverUrlA = 'ws://127.0.0.1:' + provided.server_port + '/ws';
  const sessionA = 'sc02-live-' + crypto.randomBytes(4).toString('hex');
  let createdA = false;
  let createA = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    createA = cliOutput(binA, [
      '--server-url', serverUrlA, 'sessions', 'create',
      '--agent-id', identityA, '--name', sessionA,
    ], envA);
    if (createA.status === 0) break;
    await sleep(2000);
  }
  assert.equal(createA.status, 0, 'create in A: ' + createA.output.slice(-1200));
  createdA = true;

  const before = {
    // The harness starts the product binaries directly; their live child PIDs
    // are the runtime metadata (direct binaries do not write PID files).
    serverPid: provided.server_pid,
    agentPid: provided.agent_pid,
    state: stateFingerprint(homeA),
    panes: tmuxPanes(socketA),
  };
  assert.ok(isAlive(before.serverPid), 'the provided runtime Server is not alive: ' + before.serverPid);
  assert.ok(isAlive(before.agentPid), 'the provided runtime Agent is not alive: ' + before.agentPid);
  assert.ok(before.panes.some((line) => line.includes(sessionA + ':')),
    'A did not create its own Session on its socket');

  const runB = createRunRoot('nession-4597-sc02');
  const [serverPort, agentPort, stalledPort, webPort] = await Promise.all([
    allocateLoopbackPort(), allocateLoopbackPort(), allocateLoopbackPort(), allocateLoopbackPort(),
  ]);
  let runtimeB = null;
  try {
    runtimeB = await startFullStackRuntime({
      repoRoot: REPO_ROOT,
      targetSha: TARGET,
      profile: 'full-stack-local',
      runRoot: runB.root,
      home: path.join(runB.root, 'home'),
      tmuxSocket: runB.tmux_socket,
      serverPort, agentPort, stalledProbePort: stalledPort, webPort,
      cleanupHome: true,
      cleanupRoot: true,
    });
    const homeB = path.join(runB.root, 'home');
    const identityB = fs.readFileSync(path.join(homeB, '.nession', 'agent', 'identity'), 'utf8').trim();
    assert.notEqual(identityB, identityA, 'two Agents must not share an identity file');
    const binB = cliInvocation();
    const envB = sanitizedEnv(runB.root, runB.tmux_socket, { NESION_NO_UPDATE_CHECK: '1' });
    const serverUrlB = 'ws://127.0.0.1:' + serverPort + '/ws';
    const sessionB = 'sc02-owned-' + crypto.randomBytes(4).toString('hex');
    let createB = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      createB = cliOutput(binB, [
        '--server-url', serverUrlB, 'sessions', 'create',
        '--agent-id', identityB, '--name', sessionB,
      ], envB);
      if (createB.status === 0) break;
      await sleep(2000);
    }
    assert.equal(createB.status, 0, 'create in B: ' + createB.output.slice(-1200));
    assert.ok(tmuxPanes(runB.tmux_socket).some((line) => line.includes(sessionB + ':')),
      'B did not create its Session on its own tmux socket');
    const killB = cliOutput(binB, [
      '--server-url', serverUrlB, 'sessions', 'kill',
      '--session-id', identityB + ':' + sessionB, '--force',
    ], envB);
    assert.equal(killB.status, 0, 'kill in B: ' + killB.output.slice(-1200));
    for (let attempt = 0; attempt < 15; attempt += 1) {
      if (!tmuxPanes(runB.tmux_socket).some((line) => line.includes(sessionB + ':'))) break;
      await sleep(1000);
    }
    assert.ok(!tmuxPanes(runB.tmux_socket).some((line) => line.includes(sessionB + ':')),
      'B did not clean its own Session');
    await runtimeB.stop();
    runtimeB = null;

    const after = {
      serverPid: provided.server_pid,
      agentPid: provided.agent_pid,
      state: stateFingerprint(homeA),
      panes: tmuxPanes(socketA),
    };
    assert.equal(after.serverPid, before.serverPid, 'A Server PID changed after B ran');
    assert.equal(after.agentPid, before.agentPid, 'A Agent PID changed after B ran');
    assert.ok(isAlive(after.serverPid), 'A Server process was replaced after B ran');
    assert.ok(isAlive(after.agentPid), 'A Agent process was replaced after B ran');
    assert.deepEqual(after.state, before.state,
      'A configuration/state hashes changed after B created and cleaned a Session');
    assert.deepEqual(after.panes, before.panes,
      'A tmux Session/pane identity changed after B ran');
    assert.equal(fs.existsSync(runB.root), false, 'B did not remove its owned run root');

    evidence.push({
      type: 'runtime',
      value: 'A: run ' + providedRoot.manifest.run_id + ' root ' + providedRoot.root +
        ' kept server pid ' + before.serverPid + ', agent pid ' + before.agentPid +
        ', state hashes and ' + before.panes.length + ' tmux pane identities unchanged',
    }, {
      type: 'runtime',
      value: 'B: independent root ' + runB.root + ', identity ' + identityB +
        ', created and killed its own Session on its own socket; root removed',
    });
    return {
      status: 'pass',
      summary: 'Two real Agents on separate owned roots; B created and cleaned its own Session ' +
        'without changing A PID/socket/state-hash/pane identity (exact SHA ' + TARGET + ')',
      evidence,
    };
  } finally {
    if (createdA) {
      try {
        cliOutput(binA, [
          '--server-url', serverUrlA, 'sessions', 'kill',
          '--session-id', identityA + ':' + sessionA, '--force',
        ], envA);
      } catch { /* evaluator teardown removes A */ }
    }
    if (runtimeB) {
      try { await runtimeB.stop(); } catch { /* leave the verified root for the reaper */ }
    }
    // A failed start has already run the harness's own owned teardown; a
    // remaining root is left for scripts/sweep-test-sessions.sh, never removed
    // here by a bare path.
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
