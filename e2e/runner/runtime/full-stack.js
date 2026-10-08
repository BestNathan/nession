#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(label + ' is required');
  return text;
}

function positivePort(value, label) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(label + ' must be a TCP port');
  }
  return port;
}

async function allocateLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate loopback port'));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function tomlString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function replaceRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error('runtime config template is missing ' + label);
  return source.replace(pattern, replacement);
}

function renderServerConfig(template, { serverPort, home }) {
  let output = String(template);
  output = replaceRequired(
    output,
    /^listen_address\s*=\s*"[^"]*"$/m,
    `listen_address = "127.0.0.1:${positivePort(serverPort, 'serverPort')}"`,
    'server listen_address',
  );
  output = replaceRequired(
    output,
    /^db_path\s*=\s*"[^"]*"$/m,
    `db_path = "${tomlString(path.join(requiredText(home, 'home'), 'nession.db'))}"`,
    'server db_path',
  );
  return output;
}

function renderAgentConfig(
  template,
  { serverPort, agentPort, stalledProbePort, home },
) {
  let output = String(template);
  output = replaceRequired(
    output,
    /^server_url\s*=\s*"[^"]*"$/m,
    `server_url = "ws://127.0.0.1:${positivePort(serverPort, 'serverPort')}/ws"`,
    'agent server_url',
  );
  output = replaceRequired(
    output,
    /^listen_address\s*=\s*"[^"]*"$/m,
    `listen_address = "127.0.0.1:${positivePort(agentPort, 'agentPort')}"`,
    'agent listen_address',
  );

  const urls = [...output.matchAll(/^url\s*=\s*"ws:\/\/127\.0\.0\.1:\d+\/ws"$/gm)];
  if (urls.length < 2) throw new Error('runtime agent template needs local and stalled advertise URLs');
  let urlIndex = 0;
  output = output.replace(/^url\s*=\s*"ws:\/\/127\.0\.0\.1:\d+\/ws"$/gm, () => {
    const port = urlIndex === 0
      ? positivePort(agentPort, 'agentPort')
      : positivePort(stalledProbePort, 'stalledProbePort');
    urlIndex += 1;
    return `url = "ws://127.0.0.1:${port}/ws"`;
  });

  output = replaceRequired(
    output,
    /^default_working_dir\s*=\s*"[^"]*"$/m,
    `default_working_dir = "${tomlString(requiredText(home, 'home'))}"`,
    'agent default_working_dir',
  );
  return output;
}

function assertOwnedRuntimePath(value, label) {
  const resolved = path.resolve(requiredText(value, label));
  const base = path.basename(resolved);
  if (!base.startsWith('nession-')) {
    throw new Error(label + ' must be an owned nession-* runtime directory: ' + resolved);
  }
  return resolved;
}

function assertTargetSha(repoRoot, targetSha) {
  const expected = String(targetSha ?? '').trim();
  const actual = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  if (expected && actual !== expected) {
    throw new Error(`runtime target SHA mismatch: checkout ${actual}, requested ${expected}`);
  }
  return actual;
}

async function waitForTcp(port, timeoutMs, child, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(label + ' exited before readiness with code ' + child.exitCode);
    }
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
    await sleep(200);
  }
  throw new Error(label + ' did not become ready on port ' + port + ' within ' + timeoutMs + 'ms');
}

async function waitForHttp(url, timeoutMs, child, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(label + ' exited before readiness with code ' + child.exitCode);
    }
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch {
      // Retry until the explicit readiness deadline.
    }
    await sleep(200);
  }
  throw new Error(label + ' did not become ready at ' + url + ' within ' + timeoutMs + 'ms');
}

function spawnManaged(command, args, { cwd, env, label }) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: 'inherit',
  });
  child.once('error', (error) => {
    console.error('[e2e runner] ' + label + ' spawn error:', error);
  });
  return { child, label };
}

async function stopManaged(entry) {
  if (!entry?.child || entry.child.exitCode != null) return;
  const child = entry.child;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    return;
  }

  const exited = once(child, 'exit').then(() => true);
  const timedOut = sleep(PROCESS_STOP_TIMEOUT_MS).then(() => false);
  if (await Promise.race([exited, timedOut])) return;

  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

function binaryCommand(repoRoot, packageName, binaryName, configPath) {
  const binary = path.join(repoRoot, 'target', 'debug', binaryName);
  if (existsSync(binary)) return { command: binary, args: [configPath] };
  return {
    command: 'cargo',
    args: ['run', '-p', packageName, '--', configPath],
  };
}

function verifyAndKillTmux(tmuxSocket) {
  if (!existsSync(tmuxSocket)) return;
  try {
    const reported = execFileSync(
      'tmux',
      ['-S', tmuxSocket, 'display-message', '-p', '#{socket_path}'],
      { encoding: 'utf8' },
    ).trim();
    if (reported !== tmuxSocket) {
      console.warn(
        '[e2e runner] refusing tmux cleanup: socket reported ' +
        reported + ', expected ' + tmuxSocket,
      );
      return;
    }
    execFileSync('tmux', ['-S', tmuxSocket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // No live tmux server on this owned socket.
  }
}

async function startFullStackRuntime(options) {
  const repoRoot = path.resolve(requiredText(options?.repoRoot, 'repoRoot'));
  const home = assertOwnedRuntimePath(options?.home, 'home');
  const tmuxSocket = path.resolve(requiredText(options?.tmuxSocket, 'tmuxSocket'));
  const tmuxDir = assertOwnedRuntimePath(path.dirname(tmuxSocket), 'tmux socket directory');
  const serverPort = positivePort(options?.serverPort, 'serverPort');
  const agentPort = positivePort(options?.agentPort, 'agentPort');
  const webPort = positivePort(options?.webPort, 'webPort');
  const stalledProbePort = positivePort(
    options?.stalledProbePort ?? agentPort + 1,
    'stalledProbePort',
  );
  const readyTimeoutMs = Number(options?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  const cleanupHome = options?.cleanupHome !== false;
  const targetSha = assertTargetSha(repoRoot, options?.targetSha);

  const serverTemplate = path.resolve(
    options?.serverConfigTemplate ??
    path.join(repoRoot, 'e2e', 'fixtures', 'server', 'config.toml'),
  );
  const agentTemplate = path.resolve(
    options?.agentConfigTemplate ??
    path.join(repoRoot, 'e2e', 'fixtures', 'agent-config.e2e.toml'),
  );

  rmSync(home, { recursive: true, force: true });
  rmSync(tmuxDir, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(tmuxDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(tmuxDir, 'owner.pid'), String(process.pid));

  const configDir = path.join(home, 'runtime-config');
  mkdirSync(configDir, { recursive: true });
  const serverConfig = path.join(configDir, 'server.toml');
  const agentConfig = path.join(configDir, 'agent.toml');

  writeFileSync(
    serverConfig,
    renderServerConfig(readFileSync(serverTemplate, 'utf8'), { serverPort, home }),
  );
  writeFileSync(
    agentConfig,
    renderAgentConfig(readFileSync(agentTemplate, 'utf8'), {
      serverPort,
      agentPort,
      stalledProbePort,
      home,
    }),
  );

  const isolationEnv = {
    ...process.env,
    NESSION_TMUX_SOCKET: tmuxSocket,
    NESSION_HOME: home,
  };
  const processes = [];

  const stop = async () => {
    for (const entry of [...processes].reverse()) await stopManaged(entry);
    verifyAndKillTmux(tmuxSocket);
    rmSync(tmuxDir, { recursive: true, force: true });
    if (cleanupHome) rmSync(home, { recursive: true, force: true });
  };

  try {
    const server = binaryCommand(repoRoot, 'nession-server', 'nession-server', serverConfig);
    const serverProcess = spawnManaged(server.command, server.args, {
      cwd: repoRoot,
      env: {
        ...isolationEnv,
        RUST_LOG: 'info',
        RUST_BACKTRACE: '1',
      },
      label: 'nession-server',
    });
    processes.push(serverProcess);
    await waitForTcp(serverPort, readyTimeoutMs, serverProcess.child, serverProcess.label);

    // Preserve the existing E2E stabilization window after server readiness.
    await sleep(Number(options?.agentStartDelayMs ?? 5_000));

    const agent = binaryCommand(repoRoot, 'nession-agent', 'nession-agent', agentConfig);
    const agentProcess = spawnManaged(agent.command, agent.args, {
      cwd: repoRoot,
      env: {
        ...isolationEnv,
        LANG: 'C.UTF-8',
        RUST_LOG: 'info',
        RUST_BACKTRACE: '1',
      },
      label: 'nession-agent',
    });
    processes.push(agentProcess);
    await waitForTcp(agentPort, readyTimeoutMs, agentProcess.child, agentProcess.label);

    const webProcess = spawnManaged(
      'npm',
      ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
      {
        cwd: path.join(repoRoot, 'web'),
        env: {
          ...process.env,
          NESSION_DEV_WS_PROXY: 'http://127.0.0.1:' + serverPort,
        },
        label: 'web-preview',
      },
    );
    processes.push(webProcess);
    const readinessURL = 'http://127.0.0.1:' + webPort;
    const baseURL = 'http://localhost:' + webPort;
    await waitForHttp(readinessURL, 30_000, webProcess.child, webProcess.label);

    const metadata = {
      schema_version: 1,
      target_sha: targetSha,
      profile: options?.profile ?? 'full-stack-local',
      home,
      tmux_socket: tmuxSocket,
      server_port: serverPort,
      agent_port: agentPort,
      web_port: webPort,
      base_url: baseURL,
    };
    writeFileSync(path.join(home, 'runtime.json'), JSON.stringify(metadata, null, 2) + '\n');
    console.log('[e2e runner] ready ' + JSON.stringify(metadata));

    return { ...metadata, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

function selfTest() {
  const serverTemplate = [
    'listen_address = "127.0.0.1:19090"',
    'db_path = "/tmp/nession-e2e/nession.db"',
  ].join('\n');
  const agentTemplate = [
    'server_url = "ws://127.0.0.1:19090/ws"',
    'listen_address = "127.0.0.1:19091"',
    'url = "ws://127.0.0.1:19091/ws"',
    'url = "ws://127.0.0.1:19092/ws"',
    'default_working_dir = "/tmp/nession-e2e"',
  ].join('\n');

  const home = path.join(os.tmpdir(), 'nession-runtime-selftest');
  const server = renderServerConfig(serverTemplate, { serverPort: 21090, home });
  assert.match(server, /127\.0\.0\.1:21090/);
  assert.match(server, /nession-runtime-selftest\/nession\.db/);

  const agent = renderAgentConfig(agentTemplate, {
    serverPort: 21090,
    agentPort: 21091,
    stalledProbePort: 21092,
    home,
  });
  assert.match(agent, /server_url = "ws:\/\/127\.0\.0\.1:21090\/ws"/);
  assert.match(agent, /listen_address = "127\.0\.0\.1:21091"/);
  assert.match(agent, /url = "ws:\/\/127\.0\.0\.1:21092\/ws"/);
  assert.match(agent, /default_working_dir = ".*nession-runtime-selftest"/);

  assert.throws(
    () => renderServerConfig('db_path = "/tmp/x"', { serverPort: 21090, home }),
    /listen_address/,
  );
  assert.throws(() => positivePort(0, 'port'), /TCP port/);
  console.log('e2e runner runtime self-test: 8 cases passed');
}

module.exports = {
  allocateLoopbackPort,
  assertTargetSha,
  renderAgentConfig,
  renderServerConfig,
  startFullStackRuntime,
};

if (require.main === module) {
  const command = process.argv[2];
  if (command === 'self-test') selfTest();
  else {
    console.error('usage: node e2e/runner/runtime/full-stack.js self-test');
    process.exitCode = 2;
  }
}
