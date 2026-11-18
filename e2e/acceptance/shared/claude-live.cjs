'use strict';
// Shared live-CLI machinery for the #3779 Cases (SC-01…SC-03).
//
// The deterministic verifiers prove typed negative paths in source. The
// positive path named by SCN-03 needs a real, authenticated interactive Claude
// CLI inside a Nession Session. `runner: live-cli` selects these Cases only in
// the credentialed Acceptance / Cases step, which provides the qwen gateway
// environment; this module installs the exact CLI version under test, starts
// its own Server+Agent so the Session actually inherits that CLI and those
// credentials, and drives the typed MCP Tools over the Agent endpoint.
//
// Nothing here gates a CLI version: the requested version is installed, the
// resolved version is recorded, and the product's own answer decides whether
// the version is supported. A missing gateway or missing CLI is a hard error
// (never a green Pending) because this lane exists to execute the live path.
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const AGENT_ID = 'claude-live';
const SESSION_NAME = 'claude-live';
const CLI_PACKAGE = '@anthropic-ai/claude-code';
const MCP_PROTOCOL_VERSION = '2025-03-26';
const START_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastLines(text, count = 30) {
  return String(text || '').split('\n').slice(-count).join('\n');
}

/** Collapse a runtime message into the single-line evidence contract. */
function oneLine(value, max = 400) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Poll `fn` until it returns a truthy value or the deadline passes. */
async function waitFor(label, fn, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(label + ' did not happen within ' + timeoutMs + 'ms' +
        (lastError ? ': ' + String(lastError.message || lastError) : ''));
    }
    await sleep(intervalMs);
  }
}

function requireGateway() {
  const base = String(process.env.ANTHROPIC_BASE_URL || '').trim();
  const token = String(
    process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '',
  ).trim();
  if (!base || !token) {
    throw new Error(
      'the live CLI lane requires ANTHROPIC_BASE_URL plus ANTHROPIC_AUTH_TOKEN or ' +
      'ANTHROPIC_API_KEY; refusing to claim a live proof without the gateway',
    );
  }
  return { base };
}

function requestedCliVersion() {
  const value = String(process.env.CLAUDE_CODE_VERSION || 'latest').trim() || 'latest';
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error('CLAUDE_CODE_VERSION must be an exact version or `latest`: ' + value);
  }
  return value;
}

/**
 * Install the requested CLI version into an isolated prefix and report both the
 * requested and resolved versions. A later verifier in the same job reuses the
 * prefix instead of paying for a second npm install.
 */
function installClaudeCli() {
  const requested = requestedCliVersion();
  const dir = path.join(os.tmpdir(), 'nession-live-cli', requested);
  const bin = path.join(dir, 'node_modules', '.bin', 'claude');
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(dir, { recursive: true });
    const result = spawnSync('npm', [
      'install', '--prefix', dir, '--no-save', '--no-audit', '--no-fund',
      CLI_PACKAGE + '@' + requested,
    ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error('installing ' + CLI_PACKAGE + '@' + requested + ' failed (exit ' +
        result.status + '): ' + lastLines(result.stderr || result.stdout, 12));
    }
  }
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  if (probe.error || probe.status !== 0) {
    throw new Error('the installed claude binary did not answer --version: ' +
      lastLines(probe.stderr || probe.stdout, 8));
  }
  const resolved = String(probe.stdout || '').trim().split('\n')[0].trim();
  if (!resolved) throw new Error('the installed claude binary returned an empty version');
  return { requested, resolved, bin_dir: path.dirname(bin), dir };
}

function allocateLoopbackPort() {
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

function waitForTcp(port, child, label, timeoutMs = START_TIMEOUT_MS) {
  return waitFor(label + ' listening on 127.0.0.1:' + port, () => new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(new Error(label + ' exited with code ' + child.exitCode));
      return;
    }
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  }).then((value) => {
    if (value instanceof Error) throw value;
    return value;
  }), { timeoutMs, intervalMs: 200 });
}

/**
 * The small legacy Streamable-HTTP MCP client this lane needs: initialize once
 * (the Agent advertises 2025-03-26), then tools/call with the assigned session.
 */
class McpClient {
  constructor({ port, pathname, token }) {
    this.port = port;
    this.pathname = pathname;
    this.token = token;
    this.sessionId = null;
    this.nextId = 1;
  }

  request(body, extraHeaders = {}) {
    const bytes = body === undefined ? '' : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1',
        port: this.port,
        path: this.pathname,
        method: 'POST',
        timeout: 60_000,
        headers: {
          Accept: 'application/json, text/event-stream',
          ...(bytes ? { 'Content-Type': 'application/json' } : {}),
          'Content-Length': Buffer.byteLength(bytes),
          Authorization: 'Bearer ' + this.token,
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          ...extraHeaders,
        },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({
          status: response.statusCode,
          headers: response.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      request.on('timeout', () => request.destroy(new Error('MCP request timed out')));
      request.once('error', reject);
      request.end(bytes);
    });
  }

  static decode(response) {
    const text = String(response.text || '').trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch { /* SSE */ }
    let decoded = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { decoded = JSON.parse(line.slice(5).trim()); } catch { /* other event */ }
    }
    if (decoded) return decoded;
    throw new Error('non-JSON MCP response (status ' + response.status + '): ' +
      lastLines(text, 8));
  }

  async rpc(method, params) {
    const id = this.nextId++;
    const response = await this.request({
      jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }),
    });
    if (response.status !== 200) {
      throw new Error('MCP ' + method + ' failed with HTTP ' + response.status + ': ' +
        lastLines(response.text, 8));
    }
    const payload = McpClient.decode(response);
    if (!payload) throw new Error('MCP ' + method + ' returned an empty body');
    if (payload.error) {
      throw new Error('MCP ' + method + ' error: ' +
        (payload.error.message || JSON.stringify(payload.error)));
    }
    return payload.result;
  }

  /** Initialize and complete the handshake with the assigned session id. */
  async connect() {
    const response = await this.request({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'nession-3779-live-case', version: '1' },
      },
    });
    if (response.status !== 200) {
      throw new Error('MCP initialize failed with HTTP ' + response.status + ': ' +
        lastLines(response.text, 8));
    }
    const payload = McpClient.decode(response);
    if (!payload || payload.error) {
      throw new Error('MCP initialize refused: ' +
        JSON.stringify(payload && payload.error ? payload.error : payload).slice(0, 400));
    }
    const sessionId = response.headers['mcp-session-id'];
    if (!sessionId) throw new Error('MCP initialize returned no Mcp-Session-Id');
    this.sessionId = String(sessionId);
    const notification = await this.request({
      jsonrpc: '2.0', method: 'notifications/initialized',
    });
    if (notification.status >= 300) {
      throw new Error('MCP notifications/initialized failed with HTTP ' + notification.status);
    }
    return payload.result;
  }

  async call(name, args) {
    const result = await this.rpc('tools/call', { name, arguments: args });
    if (result && result.isError) {
      const text = Array.isArray(result.content) && result.content[0]
        ? result.content[0].text
        : JSON.stringify(result);
      throw new Error(name + ' refused: ' + String(text).slice(0, 800));
    }
    if (result && result.structuredContent) return result.structuredContent;
    const text = Array.isArray(result && result.content) && result.content[0]
      ? result.content[0].text
      : null;
    if (!text) throw new Error(name + ' returned no JSON content');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(name + ' returned non-JSON content: ' + String(text).slice(0, 400));
    }
  }

  async close() {
    if (!this.sessionId) return;
    await new Promise((resolve) => {
      const request = http.request({
        hostname: '127.0.0.1',
        port: this.port,
        path: this.pathname,
        method: 'DELETE',
        timeout: 5_000,
        headers: {
          Authorization: 'Bearer ' + this.token,
          'Mcp-Session-Id': this.sessionId,
        },
      }, (response) => { response.resume(); response.on('end', resolve); });
      request.on('error', resolve);
      request.on('timeout', () => { request.destroy(); resolve(); });
      request.end();
    });
  }
}

function writeConfigs({ home, workspace, serverPort, agentPort, agentToken }) {
  const configDir = path.join(home, 'runtime-config');
  fs.mkdirSync(configDir, { recursive: true });
  const serverConfig = path.join(configDir, 'server.toml');
  const agentConfig = path.join(configDir, 'agent.toml');
  fs.writeFileSync(serverConfig, [
    'listen_address = "127.0.0.1:' + serverPort + '"',
    'tls_cert_path = ""',
    'tls_key_path = ""',
    'auth_token = ""',
    'db_path = "' + path.join(home, 'nession.db') + '"',
    'heartbeat_timeout_secs = 120',
    '',
    '[logging]',
    'level = "warn"',
    '',
  ].join('\n'));
  fs.writeFileSync(agentConfig, [
    'agent_id = "' + AGENT_ID + '"',
    'server_url = "ws://127.0.0.1:' + serverPort + '/ws"',
    'auth_token = "e2e-test-token"',
    'listen_address = "127.0.0.1:' + agentPort + '"',
    'agent_token = "' + agentToken + '"',
    'advertise_address = "127.0.0.1"',
    'disable_address_autodetect = true',
    'default_working_dir = "' + workspace + '"',
    '',
    '[[advertise_addresses]]',
    'url = "ws://127.0.0.1:' + agentPort + '/ws"',
    'label = "live case"',
    'network_type = "lan"',
    'priority = 10',
    '',
    '[mcp]',
    'enabled = true',
    'path = "/mcp"',
    'tool_timeout_secs = 120',
    '',
    '[logging]',
    'level = "warn"',
    '',
  ].join('\n'));
  return { serverConfig, agentConfig };
}

function spawnManaged(command, args, { cwd, env, label }) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const capture = (chunk) => {
    output = (output + chunk.toString('utf8')).slice(-8000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.once('error', (error) => {
    output = (output + '\nspawn error: ' + error.message).slice(-8000);
  });
  return { child, label, output: () => output };
}

async function stopManaged(entry) {
  if (!entry || entry.child.exitCode !== null) return;
  const child = entry.child;
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    child.once('exit', done);
    try { child.kill('SIGTERM'); } catch { done(); }
    setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      done();
    }, STOP_TIMEOUT_MS);
  });
}

/**
 * Start an isolated Server+Agent whose tmux Sessions inherit the installed CLI,
 * the isolated Claude home and the gateway environment.
 */
async function startLiveStack() {
  requireGateway();
  const cli = installClaudeCli();
  const serverBinary = path.join(ROOT, 'target', 'debug', 'nession-server');
  const agentBinary = path.join(ROOT, 'target', 'debug', 'nession-agent');
  for (const binary of [serverBinary, agentBinary]) {
    if (!fs.existsSync(binary)) {
      throw new Error('the live CLI lane needs the built runtime at ' + binary +
        '; the Acceptance workflow builds it before this step');
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-3779-live-'));
  const home = path.join(dir, 'home');
  const workspace = path.join(dir, 'workspace');
  const tmuxDir = path.join(dir, 'tmux');
  const claudeHome = path.join(home, 'claude');
  const tmuxSocket = path.join(tmuxDir, 'tmux.sock');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(tmuxDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(path.join(tmuxDir, 'owner.pid'), String(process.pid));
  // The Session shell re-runs login/interactive startup after tmux starts, and
  // a host zsh/bash profile may order other directories ahead of the Agent's
  // PATH. The user profile here makes the exact installed CLI win, so the
  // evidence names the version that actually ran.
  const profile = [
    '# The live Case executes the exact CLI version installed by the harness.',
    'export PATH="' + cli.bin_dir + ':$PATH"',
    'export DISABLE_AUTOUPDATER=1',
    '',
  ].join('\n');
  for (const file of ['.zshenv', '.zprofile', '.zshrc', '.bash_profile', '.bashrc', '.profile']) {
    fs.writeFileSync(path.join(claudeHome, file), profile);
  }

  const [serverPort, agentPort] = await Promise.all([
    allocateLoopbackPort(), allocateLoopbackPort(),
  ]);
  const agentToken = crypto.randomBytes(18).toString('hex');
  const { serverConfig, agentConfig } = writeConfigs({
    home, workspace, serverPort, agentPort, agentToken,
  });

  const isolationEnv = {
    ...process.env,
    NESSION_HOME: home,
    NESSION_TMUX_SOCKET: tmuxSocket,
  };
  const agentEnv = {
    ...isolationEnv,
    HOME: claudeHome,
    CLAUDE_CONFIG_DIR: path.join(claudeHome, '.claude'),
    PATH: cli.bin_dir + path.delimiter + (process.env.PATH || ''),
    // The tested version must not replace itself mid-Case.
    DISABLE_AUTOUPDATER: '1',
    RUST_LOG: 'warn',
    RUST_BACKTRACE: '1',
  };

  // The Server has no reason to hold the gateway credential; only the Agent's
  // Session environment needs it.
  const serverEnv = { ...isolationEnv, RUST_LOG: 'warn', RUST_BACKTRACE: '1' };
  delete serverEnv.ANTHROPIC_AUTH_TOKEN;
  delete serverEnv.ANTHROPIC_API_KEY;

  const processes = [];
  let mcp = null;
  const tmux = (args, { allowFailure = false } = {}) => {
    const result = spawnSync('tmux', ['-S', tmuxSocket, ...args], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !allowFailure) {
      throw new Error('tmux ' + args.join(' ') + ' failed (exit ' + result.status + '): ' +
        lastLines(result.stderr, 8));
    }
    return result;
  };

  const stop = async () => {
    if (mcp) await mcp.close();
    mcp = null;
    for (const entry of [...processes].reverse()) await stopManaged(entry);
    const recorded = tmux(['display-message', '-p', '#{socket_path}'], { allowFailure: true });
    if (recorded.status === 0 && String(recorded.stdout).trim() === tmuxSocket) {
      tmux(['kill-server'], { allowFailure: true });
    }
    // The dying tmux server may still be releasing its socket directory; a
    // bounded retry keeps teardown from masking a completed live observation.
    await sleep(250);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  const stack = {
    dir, home, workspace, tmuxSocket, cli,
    agentId: AGENT_ID,
    sessionName: SESSION_NAME,
    sessionId: AGENT_ID + ':' + SESSION_NAME,
    ports: { server: serverPort, agent: agentPort },
    capture() {
      const result = tmux(['capture-pane', '-p', '-t', SESSION_NAME]);
      return String(result.stdout || '');
    },
    sendKeys(...keys) {
      tmux(['send-keys', '-t', SESSION_NAME, ...keys]);
    },
    sendLiteral(line) {
      tmux(['send-keys', '-l', '-t', SESSION_NAME, '--', line]);
      tmux(['send-keys', '-t', SESSION_NAME, 'Enter']);
    },
    stop,
  };

  try {
    const server = spawnManaged(serverBinary, [serverConfig], {
      cwd: ROOT, env: serverEnv, label: 'nession-server',
    });
    processes.push(server);
    await waitForTcp(serverPort, server.child, 'live Server');
    const agent = spawnManaged(agentBinary, [agentConfig], {
      cwd: ROOT, env: agentEnv, label: 'nession-agent',
    });
    processes.push(agent);
    await waitForTcp(agentPort, agent.child, 'live Agent');

    mcp = new McpClient({ port: agentPort, pathname: '/mcp', token: agentToken });
    await waitFor('the Agent MCP endpoint answering initialize', async () => {
      if (agent.child.exitCode !== null) {
        throw new Error('the live Agent exited: ' + lastLines(agent.output(), 20));
      }
      try { await mcp.connect(); return true; } catch { return false; }
    }, { timeoutMs: 30_000, intervalMs: 500 });
    stack.mcp = mcp;
    return stack;
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

/** Create the named Session and wait until its shell is observable. */
async function createSession(stack) {
  const created = await stack.mcp.call('nession_agent_create_session', {
    agent_id: stack.agentId,
    name: stack.sessionName,
    working_dir: stack.workspace,
  });
  const target = { agent_id: stack.agentId, session_id: stack.sessionId };
  await waitFor('the live Session to become observable', async () => {
    const current = await stack.mcp.call('nession_claude_status', target);
    return current.observation === 'verified' && current.process === 'not_running'
      ? current
      : null;
  }, { timeoutMs: 30_000, intervalMs: 500 });
  return { target, created };
}

function status(stack) {
  return stack.mcp.call('nession_claude_status', {
    agent_id: stack.agentId, session_id: stack.sessionId,
  });
}

function enter(stack, mode, conversationId) {
  return stack.mcp.call('nession_claude_enter', {
    agent_id: stack.agentId,
    session_id: stack.sessionId,
    mode,
    ...(conversationId ? { conversation_id: conversationId } : {}),
  });
}

function submit(stack, prompt, conversationId) {
  return stack.mcp.call('nession_claude_submit', {
    agent_id: stack.agentId,
    session_id: stack.sessionId,
    conversation_id: conversationId,
    prompt,
  });
}

function getConversation(stack, conversationId, extra = {}) {
  return stack.mcp.call('nession_claude_get_conversation', {
    agent_id: stack.agentId,
    session_id: stack.sessionId,
    conversation_id: conversationId,
    ...extra,
  });
}

/**
 * Answer the interactive CLI's own first-run dialogs until the typed status
 * reports a verified, idle conversation. The pane is the only place those
 * provider-owned screens can be seen; they are not Nession state.
 */
async function settleClaude(stack, { expectedConversationId = null, timeoutMs = 90_000 } = {}) {
  let pane = '';
  // Answer each provider-owned screen once. A slow redraw must not turn one
  // poll's key press into a second Down/Enter on the next screen.
  let answered = null;
  return waitFor('the live Claude conversation to become verified and idle',
    async () => {
      pane = stack.capture();
      const screen = /Choose the text style that looks best with your terminal/.test(pane)
        ? 'theme'
        : /Press Enter to continue/.test(pane)
          ? 'continue'
          : /Yes, I trust this folder|Do you trust the files in this folder/.test(pane)
            ? 'trust'
            : null;
      if (screen) {
        if (answered !== screen) {
          answered = screen;
          stack.sendKeys(...(screen === 'trust' ? ['Down', 'Enter'] : ['Enter']));
        }
        return null;
      }
      answered = null;
      const current = await status(stack);
      const idOk = expectedConversationId === null
        ? Boolean(current.conversation_id)
        : current.conversation_id === expectedConversationId;
      return current.observation === 'verified' &&
        current.process === 'running' &&
        current.activity === 'idle' &&
        idOk
        ? current
        : null;
    }, {
      timeoutMs,
      intervalMs: 750,
    }).catch((error) => {
      throw new Error(error.message + '; pane:\n' + lastLines(pane, 24));
    });
}

/** Poll until the typed status satisfies `predicate`, returning it. */
async function waitForStatus(stack, predicate, label, timeoutMs = 60_000) {
  return waitFor(label, async () => {
    const current = await status(stack);
    return predicate(current) ? current : null;
  }, { timeoutMs, intervalMs: 500 });
}

/**
 * Give a freshly entered conversation one completed turn and wait until its
 * transcript is readable. Claude only persists a transcript once a conversation
 * has content; `/clear` and `/resume` address persisted conversations, so the
 * enter paths must start from a real one.
 */
async function seedConversation(stack, conversationId) {
  const prompt = 'Reply with the single word READY and nothing else.';
  const sent = await submit(stack, prompt, conversationId);
  if (sent.status !== 'input_sent' || sent.conversation_id !== conversationId) {
    throw new Error('the seed submit did not reach the verified conversation: ' + sent.status);
  }
  await waitForStatus(
    stack,
    (current) => current.activity === 'idle' && current.conversation_id === conversationId,
    'idle after the seed turn',
    60_000,
  );
  await waitFor('the seed transcript to become readable by the same conversation id', async () => {
    const conversation = await getConversation(stack, conversationId, { limit: 50 });
    if (conversation.state !== 'ready') return null;
    return (conversation.items || []).some(
      (item) => item.kind === 'message' && item.role === 'user' &&
        Array.isArray(item.content) &&
        item.content.some(
          (block) => block && block.type === 'text' && String(block.text || '').includes(prompt),
        ),
    ) ? conversation : null;
  }, { timeoutMs: 60_000, intervalMs: 1000 });
  return prompt;
}

/** Exit the interactive CLI so the Shell launch path can be exercised. */
async function exitClaude(stack) {
  stack.sendLiteral('/exit');
  await waitFor('the live Claude process to exit', async () => {
    const current = await status(stack);
    return current.process === 'not_running' ? current : null;
  }, { timeoutMs: 30_000, intervalMs: 500 });
}

/**
 * Run a live Case body. Synchronous Cases keep using `run`; this is the same
 * result contract for the async live path (one JSON result on stdout).
 */
async function runLive(fn) {
  const evidence = [];
  try {
    const summary = await fn({ evidence });
    process.stdout.write(JSON.stringify({ status: 'pass', summary, evidence }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      status: 'fail',
      summary: String(error && error.message ? error.message : error).slice(-4400),
      evidence: [
        ...evidence,
        { type: 'runtime', value: 'the live external-CLI path did not establish the criterion' },
      ],
    }) + '\n');
    process.exitCode = 1;
  }
}

module.exports = {
  AGENT_ID,
  ROOT,
  createSession,
  enter,
  exitClaude,
  getConversation,
  installClaudeCli,
  lastLines,
  oneLine,
  requireGateway,
  runLive,
  seedConversation,
  settleClaude,
  startLiveStack,
  status,
  submit,
  waitFor,
  waitForStatus,
};
