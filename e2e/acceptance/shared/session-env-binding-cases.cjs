'use strict';
// Shared exact-SHA steps for the #2654 Session Environment Binding Cases.
//
// The live half talks to the real Server and Agent over WebSocket and asks
// tmux what it actually holds; the test half runs the canonical #170 tests in
// the target checkout. Nothing here decides what a criterion means — each
// Case names the steps and evidence it needs.

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TOKEN = 'e2e-test-token';
const AGENT_ID = 'e2e-test-node';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeFromEnv() {
  const file = process.env.NESSION_ACCEPTANCE_RUNTIME_FILE;
  if (!file) throw new Error('NESSion_ACCEPTANCE_RUNTIME_FILE is required');
  const runtime = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(runtime.target_sha, /^[0-9a-f]{40}$/);
  assert.equal(runtime.profile, 'full-stack-local');
  assert.ok(Number.isInteger(runtime.server_port) && runtime.server_port > 0);
  assert.ok(typeof runtime.tmux_socket === 'string' && runtime.tmux_socket.endsWith('.sock'));
  return runtime;
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('WebSocket open timeout'));
    }, 10_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket open failed'));
    }, { once: true });
  });
}

function request(socket, wire, payload, id, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(wire + ' response timeout'));
    }, timeoutMs);
    const onMessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (parsed.id !== id || parsed.msg_type !== wire) return;
      cleanup();
      resolve(parsed);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('socket closed while waiting for ' + wire));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.send(JSON.stringify({ msg_type: wire, id, timestamp: Date.now(), payload }));
  });
}

async function authenticate(socket, suffix) {
  const reply = await request(socket, 'server.auth', {
    auth_token: TOKEN,
    client_id: null,
  }, 'env-2654-auth-' + suffix);
  assert.equal(reply.payload?.status, 'success', 'server.auth must succeed');
  return reply.payload;
}

async function waitForAgent(socket, suffix) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const reply = await request(socket, 'server.agent.list', {}, 'env-2654-agents-' + Date.now());
    const agents = Array.isArray(reply.payload?.agents) ? reply.payload.agents : [];
    const agent = agents.find((item) => item.agent_id === AGENT_ID);
    if (agent && agent.status !== 'offline') return agent;
    await sleep(250);
  }
  throw new Error('the real Agent did not register within the verifier deadline');
}

async function writeProfile(socket, name, content) {
  const reply = await request(socket, 'server.env.write', {
    name,
    source: 'server',
    content,
    overwrite: true,
    force: true,
  }, 'env-2654-write-' + name);
  assert.equal(reply.payload?.success, true, name + ' write failed: ' + JSON.stringify(reply.payload));
  assert.deepEqual(reply.payload?.re_sourced, [], 'a profile save must not re-source Sessions');
  return reply.payload;
}

async function createSession(socket, name, workingDir) {
  const reply = await request(socket, 'server.session.create', {
    agent_id: AGENT_ID,
    name,
    working_dir: workingDir,
    env_files: [],
  }, 'env-2654-create-' + name, 45_000);
  assert.equal(reply.payload?.success, true, name + ' create failed: ' + JSON.stringify(reply.payload));
  const sessionId = reply.payload?.session_id;
  assert.ok(sessionId, 'session create must answer a session_id');

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const list = await request(socket, 'server.session.list', { force: false },
      'env-2654-list-' + Date.now());
    const sessions = Array.isArray(list.payload?.sessions) ? list.payload.sessions : [];
    if (sessions.some((item) => item.session_id === sessionId)) return sessionId;
    await sleep(200);
  }
  throw new Error('created Session never appeared in server.session.list');
}

function bindingPayload(socket, wire, payload, id) {
  return request(socket, wire, payload, id, 45_000).then((reply) => {
    assert.equal(reply.payload?.success, true,
      wire + ' failed: ' + JSON.stringify(reply.payload));
    return reply.payload;
  });
}

function getBinding(socket, sessionId, id) {
  return bindingPayload(socket, 'server.session.env.binding.get',
    { session_id: sessionId }, id);
}

function setBinding(socket, sessionId, profiles, id) {
  return bindingPayload(socket, 'server.session.env.binding.set',
    { session_id: sessionId, profiles }, id);
}

function reapplyBinding(socket, sessionId, id) {
  return bindingPayload(socket, 'server.session.env.binding.reapply',
    { session_id: sessionId }, id);
}

function killSession(socket, sessionId, id) {
  return request(socket, 'server.session.kill', { session_id: sessionId }, id, 30_000);
}

/** What tmux actually holds for `key`, or null when it holds nothing. */
function tmuxEnvironment(tmuxSocket, sessionName, key) {
  const result = spawnSync(
    'tmux',
    ['-S', tmuxSocket, 'show-environment', '-t', sessionName, key],
    { encoding: 'utf8', timeout: 10_000 },
  );
  if (result.status !== 0) return null;
  const line = String(result.stdout || '').trim();
  if (!line || line.startsWith('-')) return null;
  const index = line.indexOf('=');
  return index === -1 ? line : line.slice(index + 1);
}

async function waitForTmuxEnvironment(tmuxSocket, sessionName, key, expected, label) {
  const deadline = Date.now() + 30_000;
  let actual = null;
  while (Date.now() < deadline) {
    actual = tmuxEnvironment(tmuxSocket, sessionName, key);
    if (actual === expected) return actual;
    await sleep(100);
  }
  throw new Error(
    label + ': tmux ' + key + ' expected ' + JSON.stringify(expected) +
    ', observed ' + JSON.stringify(actual),
  );
}

function unique(prefix) {
  return prefix + '-' + process.pid + '-' + Date.now().toString(36);
}

/**
 * The live #170 integration: two Sessions exist; only one is bound; the
 * ordered selection is materialized last-wins; removing a profile restores or
 * unsets its keys; an edit does nothing until an explicit Reapply; the
 * binding survives the client connection that created it.
 *
 * Returns single-line evidence strings.
 */
async function verifyLiveSessionBinding(runtime) {
  const profileA = unique('sc05-a') + '.env';
  const profileB = unique('sc05-b') + '.env';
  const sessionAName = unique('sc05-bound');
  const sessionBName = unique('sc05-unbound');
  const refA = { name: profileA, source: 'server' };
  const refB = { name: profileB, source: 'server' };

  const evidence = [];
  let socket = await openSocket('ws://127.0.0.1:' + runtime.server_port + '/ws');
  const created = [];
  try {
    await authenticate(socket, 'live');
    const agent = await waitForAgent(socket, 'live');
    evidence.push('server.agent.list agent_id=' + agent.agent_id + ' status=' + agent.status);

    await writeProfile(socket, profileA,
      'SC05_SHARED=from-a\nSC05_A=alpha\nSC05_REMOVED=value\n');
    await writeProfile(socket, profileB,
      'SC05_SHARED=from-b\nSC05_B=beta\n');

    const sessionA = await createSession(socket, sessionAName, runtime.home);
    created.push(sessionA);
    const sessionB = await createSession(socket, sessionBName, runtime.home);
    created.push(sessionB);

    const unbound = await getBinding(socket, sessionB, 'env-2654-b-empty');
    assert.equal(unbound.binding?.desired_revision, 0,
      'an unbound Session must have desired revision 0');
    assert.deepEqual(unbound.binding?.desired_profiles ?? [], [],
      'an unbound Session must have no desired profiles');
    assert.equal(tmuxEnvironment(runtime.tmux_socket, sessionBName, 'SC05_SHARED'), null,
      'an unbound Session must not inherit another Session’s binding');
    evidence.push('session ' + sessionBName + ' desired_revision=0 and no SC05_SHARED in tmux');

    const applied = await setBinding(socket, sessionA, [refA, refB], 'env-2654-set-ab');
    const desired = applied.binding?.desired_profiles ?? [];
    assert.deepEqual(desired.map((entry) => entry.profile.name), [profileA, profileB],
      'the whole ordered selection must be persisted in order');
    assert.ok(applied.binding?.observed, 'the Agent must report an observed state');
    assert.equal(applied.binding.observed.applied_revision, applied.binding.desired_revision,
      'materialization must report the applied revision');
    assert.ok((applied.binding.observed.managed_keys ?? []).includes('SC05_SHARED'));
    evidence.push(
      'binding.set desired_revision=' + applied.binding.desired_revision +
      ' order=' + [profileA, profileB].join(',') +
      ' observed=' + applied.binding.observed.status +
      ' applied_revision=' + applied.binding.observed.applied_revision,
    );

    await waitForTmuxEnvironment(runtime.tmux_socket, sessionAName, 'SC05_SHARED', 'from-b',
      'later profile wins');
    await waitForTmuxEnvironment(runtime.tmux_socket, sessionAName, 'SC05_A', 'alpha',
      'earlier profile remains effective');
    evidence.push('tmux ' + sessionAName + ' SC05_SHARED=from-b (last profile wins), SC05_A=alpha');

    // A new client connection must read the same binding: it is Server-owned,
    // not owned by the connection that set it.
    socket.close();
    socket = await openSocket('ws://127.0.0.1:' + runtime.server_port + '/ws');
    await authenticate(socket, 'second-client');
    const reread = await getBinding(socket, sessionA, 'env-2654-get-second-client');
    assert.deepEqual(
      (reread.binding?.desired_profiles ?? []).map((entry) => entry.profile.name),
      [profileA, profileB],
      'a second client must read the persisted ordered selection',
    );
    assert.ok(reread.binding?.observed, 'the second client must read observed state');
    evidence.push(
      'second client read desired order=' + [profileA, profileB].join(',') +
      ' observed=' + reread.binding.observed.status,
    );

    // Removing a profile restores/un-sets its keys and keeps the later value.
    const reduced = await setBinding(socket, sessionA, [refB], 'env-2654-set-b');
    assert.deepEqual(
      (reduced.binding?.desired_profiles ?? []).map((entry) => entry.profile.name),
      [profileB],
    );
    await waitForTmuxEnvironment(runtime.tmux_socket, sessionAName, 'SC05_A', null,
      'removed profile key is unset');
    await waitForTmuxEnvironment(runtime.tmux_socket, sessionAName, 'SC05_REMOVED', null,
      'removed profile key is unset');
    await waitForTmuxEnvironment(runtime.tmux_socket, sessionAName, 'SC05_SHARED', 'from-b',
      'surviving profile stays effective');
    evidence.push('binding.set [b] removed SC05_A/SC05_REMOVED and kept SC05_SHARED=from-b');

    // A profile save is not a Session mutation. Rewriting the bound profile
    // leaves tmux on the materialized value until an explicit reapply.
    await writeProfile(socket, profileB,
      'SC05_SHARED=from-b2\nSC05_B=beta2\n');
    assert.equal(tmuxEnvironment(runtime.tmux_socket, sessionAName, 'SC05_SHARED'), 'from-b',
      'a profile save must not mutate the materialized Session');
    evidence.push('profile save left tmux SC05_SHARED=from-b (no implicit mutation)');

    const reapplied = await reapplyBinding(socket, sessionA, 'env-2654-reapply');
    assert.ok(reapplied.binding.desired_revision > reduced.binding.desired_revision,
      'reapply must advance the desired revision');
    await waitForTmuxEnvironment(runtime.tmux_socket, sessionAName, 'SC05_SHARED', 'from-b2',
      'reapply materializes the edited profile');
    evidence.push(
      'binding.reapply desired_revision=' + reapplied.binding.desired_revision +
      ' materialized SC05_SHARED=from-b2',
    );
  } finally {
    for (const sessionId of created) {
      try {
        await killSession(socket, sessionId, 'env-2654-kill-' + sessionId);
      } catch {
        // The Case verdict already exists; only best-effort cleanup remains.
      }
    }
    socket.close();
  }
  return evidence;
}

function checkedCargo(args, env, timeoutMs) {
  const result = spawnSync('cargo', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      RUSTC_WRAPPER: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      ...env,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      'cargo ' + args.join(' ') + ' failed (exit ' + result.status + '): ' +
      String(result.stderr || result.stdout).slice(-4000),
    );
  }
  return String(result.stdout || '') + '\n' + String(result.stderr || '');
}

function assertRan(output, names) {
  for (const name of names) {
    if (!output.includes(name + ' ... ok')) {
      throw new Error('Missing concrete assertion: ' + name);
    }
  }
}

function runTargetCheckoutTests(runtime) {
  const env = {
    NESSION_HOME: runtime.home,
    NESSION_TMUX_SOCKET: runtime.tmux_socket,
  };
  const agent = checkedCargo(
    ['test', '-p', 'nession-agent', '--test', 'integration',
      'a_reconnect_reports_the_surviving_binding', '--', '--nocapture'],
    env,
    110_000,
  );
  assertRan(agent, ['connection::a_reconnect_reports_the_surviving_binding']);

  const server = checkedCargo(
    ['test', '-p', 'nession-server', '--lib', 'server_session_env_binding_v1', '--', '--nocapture'],
    env,
    110_000,
  );
  const names = [
    'binding_set_persists_the_whole_ordered_selection_and_reports_observed',
    'binding_reapply_resolves_current_content_at_a_new_revision',
    'legacy_unset_does_not_read_the_removed_profile',
    'an_agent_binding_report_updates_only_known_sessions',
  ];
  assertRan(server, names);
  return {
    agentTest: 'connection::a_reconnect_reports_the_surviving_binding',
    serverTests: names,
  };
}

/**
 * Run named Web tests in the target checkout and require every name to appear
 * in vitest's verbose output. Used for product states a fixture route cannot
 * reach (for example "no Session selected"): the assertion still executes on
 * the exact target SHA, and a missing test is a failure, not a skip.
 */
function runWebTestsWithNames(files, names) {
  const web = path.join(REPO_ROOT, 'web');
  const result = spawnSync('npm', ['test', '--', ...files, '--reporter=verbose'], {
    cwd: web,
    encoding: 'utf8',
    timeout: 110_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' },
  });
  if (result.error) throw result.error;
  const output = String(result.stdout || '') + '\n' + String(result.stderr || '');
  if (result.status !== 0) {
    throw new Error(
      'npm test ' + files.join(' ') + ' failed (exit ' + result.status + '): ' +
      output.slice(-4000),
    );
  }
  for (const name of names) {
    if (!output.includes(name)) {
      throw new Error('Web test did not run: ' + name + '\n' + output.slice(-4000));
    }
  }
  return { files, names };
}


function emitPass(summary, evidence) {
  process.stdout.write(JSON.stringify({ status: 'pass', summary, evidence }) + '\n');
}

function emitFailure(error) {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(message).slice(-4400),
    evidence: [{ type: 'runtime', value: 'the exact-SHA #2654 Case steps did not pass' }],
  }) + '\n');
  process.exitCode = 1;
}

module.exports = {
  REPO_ROOT,
  assertRan,
  emitFailure,
  emitPass,
  getBinding,
  reapplyBinding,
  runTargetCheckoutTests,
  runWebTestsWithNames,
  runtimeFromEnv,
  setBinding,
  tmuxEnvironment,
  verifyLiveSessionBinding,
  waitForTmuxEnvironment,
};
