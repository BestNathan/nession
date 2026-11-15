'use strict';
// Shared machinery for the #3440 endpoint-token Cases.
//
// These Cases need more than the provisioned single Server + Agent: token
// isolation needs two Agents with independent secrets, persistence needs a
// restart, and rotation needs the same Agent started again with a new value.
// The helper therefore starts its own bounded stack from the exact-checkout
// binaries with synthetic secrets, and never touches a real credential.
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');

function binary(name) {
  const file = path.join(ROOT, 'target', 'debug', name);
  if (!fs.existsSync(file)) {
    throw new Error('the Acceptance runtime must build ' + file);
  }
  return file;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate a loopback port'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForTcp(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('port ' + port + ' did not open within ' + timeoutMs + 'ms');
}

function renderServerConfig({ port, authToken, home, mcp = false }) {
  return [
    `listen_address = "127.0.0.1:${port}"`,
    'tls_cert_path = ""',
    'tls_key_path = ""',
    `auth_token = ${JSON.stringify(authToken)}`,
    `db_path = ${JSON.stringify(path.join(home, 'nession.db'))}`,
    `image_blob_dir = ${JSON.stringify(path.join(home, 'image-blobs'))}`,
    `image_build_dir = ${JSON.stringify(path.join(home, 'image-builds'))}`,
    ...(mcp ? ['', '[mcp]', 'enabled = true'] : []),
    '',
  ].join('\n');
}

function renderAgentConfig({
  agentId,
  serverPort,
  authToken,
  agentToken,
  listenPort,
  home,
  mcp = false,
}) {
  const serverUrl = serverPort === null ? '' : `ws://127.0.0.1:${serverPort}/ws`;
  return [
    `agent_id = ${JSON.stringify(agentId)}`,
    `server_url = ${JSON.stringify(serverUrl)}`,
    `auth_token = ${JSON.stringify(authToken)}`,
    `agent_token = ${JSON.stringify(agentToken)}`,
    `listen_address = "127.0.0.1:${listenPort}"`,
    `default_working_dir = ${JSON.stringify(home)}`,
    'terminal_cols = 120',
    '',
    '[[advertise_addresses]]',
    `url = "ws://127.0.0.1:${listenPort}/ws"`,
    'label = "case local"',
    'network_type = "lan"',
    'priority = 10',
    ...(mcp ? ['', '[mcp]', 'enabled = true'] : []),
    '',
  ].join('\n');
}

function spawnManaged(command, args, { env, logPath }) {
  const log = fs.openSync(logPath, 'a');
  const child = spawn(command, args, {
    detached: process.platform !== 'win32',
    stdio: ['ignore', log, log],
    env,
  });
  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    return;
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * A complete isolated stack: one Server and one or more Agents.
 *
 * All secrets are synthetic and supplied by the Case. The tmux server is the
 * Case's own private socket; nothing here can address the caller's tmux.
 */
async function startEndpointStack({ serverToken, agents, standalone = false, serverMcp = false }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-3440-'));
  const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-3440-tmux-'));
  const tmuxSocket = path.join(tmuxDir, 'tmux.sock');
  const serverPort = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    NESSION_TMUX_SOCKET: tmuxSocket,
    RUSTC_WRAPPER: '',
    NESSION_LOG_LEVEL: 'info',
  };
  const processes = [];
  const serverConfig = path.join(home, 'server.toml');
  fs.writeFileSync(
    serverConfig,
    renderServerConfig({ port: serverPort, authToken: serverToken, home, mcp: serverMcp }),
  );
  const server = spawnManaged(binary('nession-server'), [serverConfig], {
    env,
    logPath: path.join(home, 'server.log'),
  });
  processes.push(server);
  await waitForTcp(serverPort);

  const started = [];
  for (const spec of agents) {
    const agentHome = path.join(home, spec.agentId);
    fs.mkdirSync(agentHome, { recursive: true });
    const listenPort = await freePort();
    const configPath = path.join(agentHome, 'agent.toml');
    fs.writeFileSync(
      configPath,
      renderAgentConfig({
        agentId: spec.agentId,
        serverPort: standalone ? null : serverPort,
        authToken: serverToken,
        agentToken: spec.agentToken,
        listenPort,
        home: agentHome,
        mcp: spec.mcp === true,
      }),
    );
    const child = spawnManaged(binary('nession-agent'), [configPath], {
      env,
      logPath: path.join(home, spec.agentId + '.log'),
    });
    processes.push(child);
    await waitForTcp(listenPort);
    started.push({
      agentId: spec.agentId,
      agentToken: spec.agentToken,
      mcp: spec.mcp === true,
      port: listenPort,
      url: `ws://127.0.0.1:${listenPort}/ws`,
      home: agentHome,
      configPath,
      child,
    });
  }

  const stack = {
    home,
    serverToken,
    server,
    tmuxSocket,
    serverPort,
    serverUrl: `ws://127.0.0.1:${serverPort}/ws`,
    agents: started,
    async restartAgent(index, changes = {}) {
      const agent = stack.agents[index];
      await stopProcess(agent.child);
      const listenPort = changes.reusePort ? agent.port : await freePort();
      const token = changes.agentToken ?? agent.agentToken;
      fs.writeFileSync(
        agent.configPath,
        renderAgentConfig({
          agentId: agent.agentId,
          serverPort: standalone ? null : serverPort,
          authToken: serverToken,
          agentToken: token,
          listenPort,
          home: agent.home,
          mcp: agent.mcp === true,
        }),
      );
      const child = spawnManaged(binary('nession-agent'), [agent.configPath], {
        env,
        logPath: path.join(home, agent.agentId + '.log'),
      });
      processes.push(child);
      await waitForTcp(listenPort);
      Object.assign(agent, {
        child,
        port: listenPort,
        url: `ws://127.0.0.1:${listenPort}/ws`,
        agentToken: token,
      });
      return agent;
    },
    async stopServer() {
      await stopProcess(server);
    },
    async restartServer() {
      await stopProcess(server);
      const child = spawnManaged(binary('nession-server'), [serverConfig], {
        env,
        logPath: path.join(home, 'server.log'),
      });
      processes.push(child);
      Object.assign(stack, { server: child });
      await waitForTcp(serverPort);
    },
    async stop() {
      for (const child of processes.reverse()) {
        await stopProcess(child);
      }
      if (process.env.NESSION_CASE_KEEP_HOME) {
        process.stderr.write('kept case stack at ' + home + '\n');
        return;
      }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(tmuxDir, { recursive: true, force: true });
    },
  };
  return stack;
}

let frameCounter = 0;

/** A tiny protocol client over Node's global WebSocket. */
async function openFrames(url, timeoutMs = 10_000) {
  const ws = new WebSocket(url);
  const frames = [];
  const waiters = [];
  let closed = false;
  let closeReason = null;

  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    frames.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].predicate(message)) {
        const waiter = waiters.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  const markClosed = (reason) => {
    if (closed) return;
    closed = true;
    closeReason = reason;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('socket closed before ' + waiter.label + (reason ? ': ' + reason : '')));
    }
  };
  ws.addEventListener('close', () => markClosed('closed'));
  ws.addEventListener('error', () => markClosed('transport error'));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket did not open: ' + url)), timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket closed before open: ' + url));
    });
  });

  return {
    ws,
    frames,
    get closed() {
      return closed;
    },
    get closeReason() {
      return closeReason;
    },
    send(msgType, payload = {}) {
      frameCounter += 1;
      const id = 'case-' + frameCounter;
      ws.send(JSON.stringify({ msg_type: msgType, id, timestamp: Date.now(), payload }));
      return id;
    },
    /** Send a request and wait for the frame carrying its id. */
    async request(msgType, payload = {}, timeoutMs = 10_000) {
      const id = this.send(msgType, payload);
      return await this.waitFor((message) => message.id === id, timeoutMs, 'reply to ' + msgType);
    },
    waitFor(predicate, timeoutMs = 10_000, label = 'frame') {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          label,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error('timed out waiting for ' + label));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    waitForClose(timeoutMs = 10_000) {
      if (closed) return Promise.resolve(closeReason);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
        ws.addEventListener('close', () => {
          clearTimeout(timer);
          resolve(closeReason);
        });
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
  };
}

async function authenticateServer(client, token) {
  const reply = await client.request('server.auth', { auth_token: token, client_id: 'case' });
  return reply.payload;
}

async function authenticateAgent(client, token, clientId = 'case-client') {
  const reply = await client.request('client.auth', {
    auth_token: token,
    client_id: clientId,
  });
  return reply;
}

async function waitForAgentOnline(stack, agentId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = await openFrames(stack.serverUrl);
    try {
      const auth = await authenticateServer(client, stack.serverToken ?? '');
      if (auth.status !== 'success') throw new Error('Server auth failed while waiting: ' + auth.message);
      const reply = await client.request('server.agent.list', {});
      const agents = reply.payload?.agents ?? reply.payload?.agent_list ?? [];
      const found = agents.find((agent) => agent.agent_id === agentId || agent.id === agentId);
      if (found && (found.status === 'online' || found.online === true)) return found;
    } catch {
      /* retry */
    } finally {
      client.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Agent ' + agentId + ' did not register as online');
}

module.exports = {
  ROOT,
  binary,
  freePort,
  openFrames,
  renderAgentConfig,
  authenticateAgent,
  authenticateServer,
  startEndpointStack,
  waitForAgentOnline,
};
