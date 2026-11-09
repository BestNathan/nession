'use strict';
// Shared machinery for the #3124 Sandbox context-capability Cases.
//
// The capability is a Session/Pane surface, so the proof has to observe the
// real Server + Agent: the active Pane changes when Enter creates the isolated
// Window, the original Pane survives, and a duplicated or stale Enter is
// refused. These helpers drive the authenticated Server protocol exactly as
// the Web client does; they do not import product code.
const fs = require('node:fs');

const AGENT_ID = 'e2e-test-node';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeFromEnv() {
  const runtimeFile = process.env.NESSION_ACCEPTANCE_RUNTIME_FILE;
  if (!runtimeFile) throw new Error('NESSON_ACCEPTANCE_RUNTIME_FILE is required');
  return JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('WebSocket open timeout'));
    }, 5_000);
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

let nextId = 0;

function request(socket, msgType, payload, timeout) {
  const id = 'acceptance-sandbox-' + (++nextId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(msgType + ' response timeout'));
    }, timeout || 15_000);
    const onMessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (parsed.id !== id || parsed.msg_type !== msgType) return;
      cleanup();
      resolve(parsed.payload);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('socket closed while waiting for ' + msgType));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.send(JSON.stringify({ msg_type: msgType, id, timestamp: Date.now(), payload }));
  });
}

/** Authenticate to the real Server and wait for the real Agent to be online. */
async function openClient(runtime) {
  const socket = await openSocket('ws://127.0.0.1:' + runtime.server_port + '/ws');
  const auth = await request(socket, 'server.auth', {
    auth_token: 'e2e-test-token',
    client_id: null,
  });
  if (auth.status !== 'success') {
    throw new Error('server.auth did not succeed: ' + JSON.stringify(auth));
  }
  const deadline = Date.now() + 20_000;
  let online = false;
  while (Date.now() < deadline) {
    const reply = await request(socket, 'server.agent.list', {});
    const agents = Array.isArray(reply.agents) ? reply.agents : [];
    if (agents.some((agent) => agent.agent_id === AGENT_ID && agent.status === 'online')) {
      online = true;
      break;
    }
    await sleep(250);
  }
  if (!online) {
    socket.close();
    throw new Error('the real Agent ' + AGENT_ID + ' was not online within the verifier deadline');
  }
  return {
    runtime,
    request: (msgType, payload, timeout) => request(socket, msgType, payload, timeout),
    close: () => socket.close(),
  };
}

async function createSession(client, name, workingDir) {
  const reply = await client.request('server.session.create', {
    agent_id: AGENT_ID,
    name,
    working_dir: workingDir,
  }, 45_000);
  if (!reply.success || !reply.session_id) {
    throw new Error('server.session.create refused: ' + JSON.stringify(reply));
  }
  return reply.session_id;
}

async function killSession(client, sessionId) {
  const reply = await client.request('server.session.kill', { session_id: sessionId }, 30_000);
  return reply;
}

async function context(client, sessionId) {
  return client.request('server.session.sandbox.context', { session_id: sessionId }, 30_000);
}

async function preflight(client, sessionId, generation, policy, workingDir) {
  return client.request('server.session.sandbox.preflight', {
    session_id: sessionId,
    generation,
    policy,
    working_dir: workingDir || '',
  }, 45_000);
}

async function enter(client, sessionId, generation, enterId, policy, workingDir) {
  return client.request('server.session.sandbox.enter', {
    session_id: sessionId,
    generation,
    enter_id: enterId,
    policy,
    working_dir: workingDir || '',
  }, 75_000);
}

async function returnToNative(client, sessionId) {
  return client.request('server.session.sandbox.return-to-native', { session_id: sessionId }, 30_000);
}

async function focus(client, sessionId, paneId) {
  return client.request('server.session.sandbox.focus', {
    session_id: sessionId,
    pane_id: paneId,
  }, 30_000);
}

async function processes(client, sessionId) {
  return client.request('server.session.processes', { session_id: sessionId }, 30_000);
}

/** The policy every #3124 native Case enters with: no optional KV rows. */
function isolationPolicy() {
  return {
    version: 1,
    enabled: true,
    network: { mode: 'deny' },
    process: { linux_namespaces: { pid: true, ipc: true, user: true, uts: true, cgroup: false } },
    resource: [],
    syscall: [],
    enforcement: 'required',
  };
}

/**
 * Run an async Case body and emit the Acceptance JSON contract.
 *
 * Same contract as `control-mode-cases.cjs`'s `run`, but for a runtime that
 * answers asynchronously. A Pending decision is emitted by the caller.
 */
async function runSandboxCase(fn) {
  const evidence = [];
  try {
    const summary = await fn({ evidence });
    process.stdout.write(JSON.stringify({ status: 'pass', summary, evidence }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      status: 'fail',
      summary: String(error && error.message ? error.message : error).slice(-4400),
      evidence: [{
        type: 'runtime',
        value: 'the authenticated Server/Agent obligation was not established',
      }],
    }) + '\n');
    process.exitCode = 1;
  }
}

module.exports = {
  AGENT_ID,
  runtimeFromEnv,
  openClient,
  createSession,
  killSession,
  context,
  preflight,
  enter,
  returnToNative,
  focus,
  processes,
  isolationPolicy,
  runSandboxCase,
  sleep,
};
