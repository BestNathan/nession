'use strict';
// Shared exact-SHA steps for the #845 Git write-operation Cases.
//
// Every Case talks to the real full-stack runtime: a real Server, a real Agent,
// a real tmux Session, and a real git repository created on the same isolated
// host. The verifier can edit files between calls because it is on that host —
// that is how the Terminal-side race is reproduced without driving tmux input.
//
// Nothing here decides what a criterion means. Each Case names the steps and
// the evidence it needs; this module only makes the steps repeatable.

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN = 'e2e-test-token';
const AGENT_ID = 'e2e-test-node';
const SCRUBBED_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeFromEnv() {
  const file = process.env.NESSION_ACCEPTANCE_RUNTIME_FILE;
  if (!file) throw new Error('NESSion_ACCEPTANCE_RUNTIME_FILE is required');
  const runtime = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(runtime.target_sha, /^[0-9a-f]{40}$/, 'exact target SHA required');
  assert.equal(runtime.profile, 'full-stack-local');
  assert.ok(Number.isInteger(runtime.server_port) && runtime.server_port > 0);
  assert.ok(typeof runtime.home === 'string' && runtime.home.length > 0);
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

let sequence = 0;

function request(socket, wire, payload, timeoutMs = 30_000) {
  const id = '845-' + process.pid + '-' + (++sequence);
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
      resolve(parsed.payload);
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

async function openStack() {
  const runtime = runtimeFromEnv();
  const socket = await openSocket('ws://127.0.0.1:' + runtime.server_port + '/ws');
  try {
    const auth = await request(socket, 'server.auth', {
      auth_token: TOKEN,
      client_id: null,
    });
    assert.equal(auth?.status, 'success', 'server.auth must succeed');

    const deadline = Date.now() + 30_000;
    let agent = null;
    while (Date.now() < deadline) {
      const list = await request(socket, 'server.agent.list', {});
      const agents = Array.isArray(list?.agents) ? list.agents : [];
      agent = agents.find((item) => item.agent_id === AGENT_ID && item.status !== 'offline');
      if (agent) break;
      await sleep(250);
    }
    assert.ok(agent, 'the real Agent did not register with the Server');

    return {
      runtime,
      socket,
      agent,
      ask: (wire, payload, timeoutMs) => request(socket, wire, payload, timeoutMs),
      close: () => socket.close(),
    };
  } catch (error) {
    socket.close();
    throw error;
  }
}

function gitEnv() {
  const env = { ...process.env };
  for (const name of SCRUBBED_ENV) delete env[name];
  return env;
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    env: gitEnv(),
    encoding: 'utf8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Run git where a non-zero exit is the assertion (a merge conflict, say). */
function gitTry(dir, args) {
  return spawnSync('git', ['-C', dir, ...args], {
    env: gitEnv(),
    encoding: 'utf8',
    timeout: 20_000,
  });
}

/**
 * A committed repository the Session can be pointed at.
 *
 * `identity: null` leaves the author identity unusable, which is how the
 * missing-identity branch is produced deterministically without depending on
 * the host's global git configuration.
 */
function makeRepo(home, name, { identity = 'acceptance', unborn = false } = {}) {
  const dir = path.join(home, 'git-write-' + name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  if (identity === null) {
    git(dir, ['config', 'user.name', '']);
    git(dir, ['config', 'user.email', 'nobody@example.com']);
  } else {
    git(dir, ['config', 'user.name', 'Acceptance Test']);
    git(dir, ['config', 'user.email', 'acceptance@example.com']);
  }
  if (!unborn) {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-qm', 'initial']);
  }
  return dir;
}

async function createSession(stack, name, workingDir) {
  const reply = await stack.ask('server.session.create', {
    agent_id: AGENT_ID,
    name,
    working_dir: workingDir,
    env_files: [],
  }, 45_000);
  assert.equal(reply?.success, true, name + ' create failed: ' + JSON.stringify(reply));
  const sessionId = reply.session_id;
  assert.ok(sessionId, 'session create must answer a session_id');

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const list = await stack.ask('server.session.list', { force: true });
    const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
    if (sessions.some((item) => item.session_id === sessionId)) {
      // The pane exists; give the Agent a bounded moment to resolve its live
      // directory into the repository the Case just created.
      const readyDeadline = Date.now() + 15_000;
      for (;;) {
        const probe = await gitAsk(stack, 'git.status', {
          session: sessionId,
          contract_version: 2,
        });
        if (probe?.state === 'ok' || Date.now() >= readyDeadline) break;
        await sleep(250);
      }
      return sessionId;
    }
    await sleep(200);
  }
  throw new Error('created Session never appeared in server.session.list');
}

/** Ask one git unit over the real relay. */
function gitAsk(stack, wire, payload) {
  return stack.ask(wire, {
    agent_id: AGENT_ID,
    ...payload,
  });
}

async function status(stack, session, version = 2) {
  // A freshly created tmux Session may not have reported its pane cwd yet;
  // `session_workdir_unknown` is a readiness answer, not a product failure.
  const deadline = Date.now() + 15_000;
  let response;
  for (;;) {
    response = await gitAsk(stack, 'git.status', { session, contract_version: version });
    if (
      response?.state !== 'unavailable' ||
      response?.reason !== 'session_workdir_unknown' ||
      Date.now() >= deadline
    ) {
      break;
    }
    await sleep(250);
  }
  assert.equal(response?.state, 'ok', 'git.status failed: ' + JSON.stringify(response));
  return response;
}

async function diff(stack, session, file, kind) {
  const response = await gitAsk(stack, 'git.diff', {
    session,
    contract_version: 2,
    path: file,
    source: { kind },
  });
  assert.equal(response?.state, 'ok', 'git.diff failed: ' + JSON.stringify(response));
  return response;
}

function stage(stack, session, file, expectedSnapshot) {
  return gitAsk(stack, 'git.stage', {
    session,
    contract_version: 1,
    path: file,
    expected_snapshot: expectedSnapshot,
  });
}

function unstage(stack, session, file, expectedSnapshot) {
  return gitAsk(stack, 'git.unstage', {
    session,
    contract_version: 1,
    path: file,
    expected_snapshot: expectedSnapshot,
  });
}

function createCommit(stack, session, expectedSnapshot, message, requestId) {
  return gitAsk(stack, 'git.create-commit', {
    session,
    contract_version: 1,
    expected_snapshot: expectedSnapshot,
    message,
    request_id: requestId,
  });
}

function head(dir) {
  return git(dir, ['rev-parse', 'HEAD']);
}

function revCount(dir) {
  return Number(git(dir, ['rev-list', '--count', 'HEAD']));
}

function pass(summary, evidence) {
  return { status: 'pass', summary, evidence };
}

function run(main) {
  main()
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      console.log(JSON.stringify({
        status: 'fail',
        summary: message,
        evidence: [{ type: 'runtime', value: 'real-stack Git write acceptance step failed' }],
      }));
      process.exitCode = 1;
    });
}

module.exports = {
  AGENT_ID,
  createCommit,
  createSession,
  diff,
  git,
  gitAsk,
  gitTry,
  head,
  makeRepo,
  openStack,
  pass,
  revCount,
  run,
  stage,
  status,
  unstage,
};
