#!/usr/bin/env node
// #3791 SC-02: isolated standalone-MCP container proof.
//
// Builds the real prebuilt image and a native Server, runs the container with
// no Server/Agent process inside it, mounts the documented read-only config and
// exercises the canonical Server route. Each mode is a separate process so a
// Case verifier stays inside the runner's per-verifier deadline:
//
//   build-binary  cargo build the MCP host and the test Server
//   build-image   docker buildx build Dockerfile.mcp.prebuilt
//   verify        protocol/security/fail-closed/SIGTERM/payload assertions
//
// No production credential is used. Test tokens are generated per run and
// never printed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetSha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA || '');
if (!/^[a-f0-9]{40}$/.test(targetSha)) {
  throw new Error('exact target SHA is required');
}
const shortSha = targetSha.slice(0, 7);
const stateFile = path.join(os.tmpdir(), 'nession-3791-sc02-' + shortSha + '.json');
const imageTag = 'nession-mcp-3791:' + shortSha;
const inboundToken = 'nession-3791-inbound-' + process.pid;
const serverToken = 'nession-3791-server-' + process.pid;

function readState() {
  assert.ok(fs.existsSync(stateFile), 'prepare verifier did not run');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.target_sha, targetSha, 'prepared state belongs to another SHA');
  return state;
}

function writeState(patch) {
  const current = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    : { target_sha: targetSha };
  assert.equal(current.target_sha, targetSha);
  fs.writeFileSync(stateFile, JSON.stringify({ ...current, ...patch }) + '\n');
}

function run(command, args, timeout, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', RUSTC_WRAPPER: '' },
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(command + ' ' + args.join(' ') + ' failed (exit ' + result.status + '): ' +
      String(result.stderr || result.stdout).slice(-3000));
  }
  return String(result.stdout) + '\n' + String(result.stderr);
}

function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, deadlineMs) {
  const until = Date.now() + deadlineMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      const retry = () => {
        socket.destroy();
        if (Date.now() > until) reject(new Error('port ' + port + ' never accepted'));
        else setTimeout(attempt, 150);
      };
      socket.once('error', retry);
      socket.setTimeout(1000, retry);
    };
    attempt();
  });
}

function request(port, method, body, headers = {}) {
  const bytes = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/mcp', method, timeout: 12000,
      headers: {
        Host: 'mcp.nession.test',
        Accept: 'application/json, text/event-stream',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'Content-Length': Buffer.byteLength(bytes),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('MCP request timed out')));
    req.once('error', reject);
    req.end(bytes);
  });
}

function decoded(response, context) {
  try { return JSON.parse(response.text); } catch {}
  for (const line of response.text.split(/\r?\n/)) {
    if (line.startsWith('data: ')) {
      try { return JSON.parse(line.slice(6)); } catch {}
    }
  }
  throw new Error(context + ': non-JSON MCP result (status ' + response.status + '): ' +
    response.text.slice(0, 400));
}

function rpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
}

function writeMcpConfig(file, { listenPort, authToken = inboundToken, serverPort = null }) {
  const lines = [
    '[mcp]',
    'listen_address = "0.0.0.0:' + listenPort + '"',
    'auth_token = "' + authToken + '"',
    'allowed_hosts = ["mcp.nession.test"]',
    'allowed_origins = []',
    '',
  ];
  if (serverPort !== null) {
    lines.push(
      '[backend.server]',
      'endpoint = "ws://127.0.0.1:' + serverPort + '/ws"',
      'auth_token = "' + serverToken + '"',
      '',
    );
  }
  fs.writeFileSync(file, lines.join('\n'));
}

function startServer(dir, port) {
  const serverConfig = path.join(dir, 'server.toml');
  const home = path.join(dir, 'server-home');
  const env = {
    ...process.env,
    SERVER_AUTH_TOKEN: serverToken,
    SERVER_LISTEN: '127.0.0.1:' + port,
    NESSION_HOME: home,
    NESSION_MCP_ENABLED: 'false',
    NESSION_TERMINAL_COLS: '96',
    NESSION_TERMINAL_WEB_FONT_SIZE: '14',
  };
  const render = spawnSync('sh', [path.join(root, 'deploy/render-server-config.sh'), serverConfig], {
    cwd: root, encoding: 'utf8', timeout: 15000, env,
  });
  assert.equal(render.status, 0, 'Server config renderer failed: ' + render.stderr);
  let output = '';
  const child = spawn(path.join(root, 'target/debug/nession-server'), [serverConfig], {
    cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (buffer) => { output = (output + buffer.toString('utf8')).slice(-4000); });
  }
  return { child, output: () => output };
}

function assertTokensAbsent(text, context) {
  assert.equal(text.includes(inboundToken), false, context + ' leaked the inbound MCP token');
  assert.equal(text.includes(serverToken), false, context + ' leaked the Server credential');
}

async function buildBinary() {
  run('cargo', ['build', '-p', 'nession-mcp', '-p', 'nession-server'], 100000);
  const mcp = path.join(root, 'target/debug/nession-mcp');
  const server = path.join(root, 'target/debug/nession-server');
  assert.ok(fs.existsSync(mcp), 'nession-mcp binary was not built');
  assert.ok(fs.existsSync(server), 'nession-server binary was not built');
  writeState({ binary: mcp, server });
  const probe = spawnSync('file', [mcp], { encoding: 'utf8', timeout: 15000 });
  const description = probe.status === 0
    ? String(probe.stdout).trim().split('\n')[0]
    : 'ELF architecture is checked by the image build';
  console.log(JSON.stringify({
    status: 'pass',
    summary: 'built the standalone MCP host and test Server for the exact target SHA',
    evidence: [{ type: 'runtime', value: 'cargo build -p nession-mcp -p nession-server at ' + targetSha + '; ' + description }],
  }));
}

async function buildImage() {
  const state = readState();
  assert.ok(fs.existsSync(state.binary), 'MCP binary is missing; run build-binary first');
  const audit = run('docker', [
    'buildx', 'build', '--load',
    '--build-context', 'mcp-bin=' + path.dirname(state.binary),
    '--build-arg', 'NESSION_SOURCE_REVISION=' + targetSha,
    '-f', 'Dockerfile.mcp.prebuilt',
    '-t', imageTag,
    '.',
  ], 100000);
  const id = run('docker', ['image', 'inspect', '--format', '{{.Id}}', imageTag], 15000).trim();
  writeState({ image: imageTag, image_id: id });
  const machines = run('docker', ['run', '--rm', '--entrypoint', 'sh', imageTag, '-c',
    'od -An -t x1 -j 18 -N 2 /usr/local/bin/nession-mcp | tr -d " \\n"'], 30000).trim();
  assert.match(machines, /^(3e00|b700)$/, 'image binary is not a supported ELF architecture');
  console.log(JSON.stringify({
    status: 'pass',
    summary: 'built Dockerfile.mcp.prebuilt with the checked-out architecture-matched binary',
    evidence: [
      { type: 'runtime', value: 'docker buildx build ' + imageTag + '; image_id=' + id },
      { type: 'runtime', value: 'image ELF e_machine=' + machines + ' (amd64 3e00 / arm64 b700)' },
      { type: 'runtime', value: 'docker build output tail: ' + audit.trim().split('\n').slice(-1)[0] },
    ],
  }));
}

async function verify() {
  const state = readState();
  assert.ok(state.image, 'image is missing; run build-image first');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-3791-sc02-run-'));
  const name = 'nession-3791-sc02-' + process.pid;
  let container = false;
  let server = null;
  const evidence = [];
  try {
    const [serverPort, mcpPort] = await Promise.all([ephemeralPort(), ephemeralPort()]);
    server = startServer(dir, serverPort);
    await waitForPort(serverPort, 30000);
    assertTokensAbsent(server.output(), 'native Server log');

    const config = path.join(dir, 'mcp.toml');
    writeMcpConfig(config, { listenPort: mcpPort, serverPort });
    const started = run('docker', [
      'run', '-d', '--name', name, '--network', 'host',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '-v', config + ':/etc/nession/mcp.toml:ro',
      state.image,
    ], 30000).trim();
    assert.match(started, /^[a-f0-9]{64}$/, 'docker run did not return a container id');
    container = true;

    const authed = { Authorization: 'Bearer ' + inboundToken };
    const waiting = Date.now() + 30000;
    for (;;) {
      try {
        const probe = await request(mcpPort, 'POST', rpc('initialize', {
          protocolVersion: '2025-03-26', capabilities: {},
          clientInfo: { name: 'nession-3791-case', version: '1' },
        }), authed);
        if (probe.status === 200) break;
      } catch {}
      if (Date.now() > waiting) {
        throw new Error('MCP container never became ready: ' + run('docker', ['logs', name], 20000));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const noAuth = await request(mcpPort, 'POST', rpc('tools/list'));
    assert.equal(noAuth.status, 401, 'missing bearer must be refused');
    const wrong = await request(mcpPort, 'POST', rpc('tools/list'), {
      Authorization: 'Bearer ' + serverToken,
    });
    assert.equal(wrong.status, 401, 'the outbound Server token must not authorize inbound MCP');
    const badOrigin = await request(mcpPort, 'POST', rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'nession-3791-case', version: '1' },
    }), { ...authed, Origin: 'https://attacker.example.invalid' });
    assert.notEqual(badOrigin.status, 200, 'a foreign browser Origin must be refused');
    const badHost = await request(mcpPort, 'POST', rpc('tools/list'), {
      ...authed, Host: 'attacker.example.invalid',
    });
    assert.notEqual(badHost.status, 200, 'a Host outside allowed_hosts must be refused');
    assert.ok(!/<!doctype html/i.test(badHost.text + badOrigin.text),
      'an unauthenticated MCP request received the Web UI');
    evidence.push({ type: 'runtime', value: 'container ' + name + ': missing/wrong bearer 401, foreign Origin and Host refused' });

    const init = await request(mcpPort, 'POST', rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'nession-3791-case', version: '1' },
    }), authed);
    assert.equal(init.status, 200, 'legacy initialize failed: ' + init.text.slice(0, 400));
    const session = init.headers['mcp-session-id'];
    assert.ok(typeof session === 'string' && session.length > 0, 'legacy session id missing');
    const list = await request(mcpPort, 'POST', rpc('tools/list'), {
      ...authed, 'Mcp-Session-Id': session,
    });
    assert.equal(list.status, 200, 'legacy tools/list failed: ' + list.text.slice(0, 400));
    const tools = decoded(list, 'tools/list').result.tools;
    assert.ok(tools.some((tool) => tool.name === 'nession_server_list_agents'),
      'the shared catalog is missing the Server discovery Tool');
    const read = await request(mcpPort, 'POST', rpc('tools/call', {
      name: 'nession_server_list_agents', arguments: {},
    }), { ...authed, 'Mcp-Session-Id': session });
    assert.equal(read.status, 200, 'legacy safe read failed: ' + read.text.slice(0, 400));
    const legacyResult = decoded(read, 'legacy read').result;
    assert.notEqual(legacyResult?.isError, true, 'legacy safe read returned a Tool error');
    const agents = JSON.parse(legacyResult.content[0].text).agents;
    assert.ok(Array.isArray(agents), 'legacy read did not reach the canonical Server route');
    evidence.push({ type: 'runtime', value: 'legacy 2025-03-26: initialize + tools/list (' + tools.length + ') + nession_server_list_agents via the Server route' });

    const modernVersion = '2026-07-28';
    const modernMeta = {
      'io.modelcontextprotocol/protocolVersion': modernVersion,
      'io.modelcontextprotocol/clientInfo': { name: 'nession-3791-case', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const discovery = await request(mcpPort, 'POST', rpc('server/discover', { _meta: modernMeta }), {
      ...authed, 'MCP-Protocol-Version': modernVersion, 'Mcp-Method': 'server/discover',
    });
    assert.equal(discovery.status, 200, 'modern discovery failed: ' + discovery.text.slice(0, 400));
    const supported = decoded(discovery, 'discover').result.supportedVersions;
    assert.ok(supported.includes(modernVersion) && supported.includes('2025-03-26'),
      'modern discovery lost an advertised protocol version');
    const modernRead = await request(mcpPort, 'POST', rpc('tools/call', {
      name: 'nession_server_list_agents', arguments: {}, _meta: modernMeta,
    }), {
      ...authed, 'MCP-Protocol-Version': modernVersion,
      'Mcp-Method': 'tools/call', 'Mcp-Name': 'nession_server_list_agents',
    });
    assert.equal(modernRead.status, 200, 'modern safe read failed: ' + modernRead.text.slice(0, 400));
    const modernResult = decoded(modernRead, 'modern read').result;
    assert.notEqual(modernResult?.isError, true, 'modern safe read returned a Tool error');
    assert.ok(Array.isArray(JSON.parse(modernResult.content[0].text).agents),
      'modern read did not reach the canonical Server route');
    evidence.push({ type: 'runtime', value: 'modern 2026-07-28: server/discover + nession_server_list_agents via the Server route' });

    const env = run('docker', ['image', 'inspect', '--format', '{{json .Config.Env}}', state.image], 15000);
    assertTokensAbsent(env, 'image metadata');
    const labels = run('docker', ['image', 'inspect', '--format', '{{json .Config.Labels}}', state.image], 15000);
    const revision = JSON.parse(labels)['org.opencontainers.image.revision'];
    assert.equal(revision, targetSha, 'image revision label does not bind the target SHA');
    const logs = run('docker', ['logs', name], 20000);
    assertTokensAbsent(logs, 'container logs');
    evidence.push({ type: 'runtime', value: 'image metadata/logs carry no credential; org.opencontainers.image.revision=' + revision });

    const pure = run('docker', ['run', '--rm', '--entrypoint', 'sh', state.image, '-c',
      'set -e; for p in nginx tmux node mkfs.erofs erofsfuse bubblewrap nession-server nession-agent; do ' +
      'if command -v "$p" >/dev/null 2>&1; then echo forbidden:$p; exit 1; fi; done; ' +
      'test ! -e /usr/share/nginx/html; test ! -e /etc/nginx; ' +
      'test -x /usr/local/bin/nession-mcp; echo PURE'], 30000);
    assert.match(pure, /PURE/, 'payload exclusion probe failed: ' + pure.slice(-400));
    evidence.push({ type: 'runtime', value: 'container payload excludes Server/Agent/nginx/Web/tmux/Node/EROFS binaries' });

    const missingConfig = spawnSync('docker', ['run', '--rm', '--network', 'none', state.image], {
      cwd: root, encoding: 'utf8', timeout: 30000,
    });
    assert.notEqual(missingConfig.status, 0, 'absent configuration incorrectly started');
    assert.match(String(missingConfig.stderr) + String(missingConfig.stdout), /could not read .*mcp\.toml/,
      'absent configuration did not report the missing document');
    const emptyToken = path.join(dir, 'empty-token.toml');
    writeMcpConfig(emptyToken, { listenPort: mcpPort, authToken: '', serverPort });
    const noInbound = spawnSync('docker', ['run', '--rm', '--network', 'none',
      '-v', emptyToken + ':/etc/nession/mcp.toml:ro', state.image], {
      cwd: root, encoding: 'utf8', timeout: 30000,
    });
    assert.notEqual(noInbound.status, 0, 'an anonymous MCP endpoint incorrectly started');
    assert.match(String(noInbound.stderr) + String(noInbound.stdout), /auth_token is required/,
      'empty inbound token did not fail closed');
    const noBackend = path.join(dir, 'no-backend.toml');
    writeMcpConfig(noBackend, { listenPort: mcpPort });
    const noServer = spawnSync('docker', ['run', '--rm', '--network', 'none',
      '-v', noBackend + ':/etc/nession/mcp.toml:ro', state.image], {
      cwd: root, encoding: 'utf8', timeout: 30000,
    });
    assert.notEqual(noServer.status, 0, 'a document without [backend.server] incorrectly started');
    assert.match(String(noServer.stderr) + String(noServer.stdout), /\[backend\.server\] is required/,
      'missing outbound Server configuration did not fail closed');
    evidence.push({ type: 'runtime', value: 'absent config, empty inbound token and missing [backend.server] all exit non-zero before serving' });

    assertTokensAbsent(run('docker', ['logs', name], 20000), 'container logs after negative cases');
    const stopStarted = Date.now();
    const stop = spawnSync('docker', ['stop', '--time', '10', name], { encoding: 'utf8', timeout: 20000 });
    const stopMs = Date.now() - stopStarted;
    assert.equal(stop.status, 0, 'docker stop failed: ' + stop.stderr);
    assert.ok(stopMs < 10000, 'SIGTERM did not drain the MCP process in time: ' + stopMs + 'ms');
    const exitCode = run('docker', ['inspect', '--format', '{{.State.ExitCode}}', name], 15000).trim();
    assert.equal(exitCode, '0', 'MCP process did not exit cleanly on SIGTERM');
    evidence.push({ type: 'runtime', value: 'SIGTERM: docker stop drained in ' + stopMs + 'ms, exit code 0' });

    console.log(JSON.stringify({
      status: 'pass',
      summary: 'isolated standalone MCP container authenticates, discovers and reads through the canonical Server route; missing/wrong credentials and Host/Origin fail closed; SIGTERM drains',
      evidence,
    }));
  } finally {
    if (container) {
      spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 20000 });
    }
    if (server) {
      server.child.kill('SIGTERM');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const mode = process.argv[2];
if (mode === 'build-binary') await buildBinary();
else if (mode === 'build-image') await buildImage();
else if (mode === 'verify') await verify();
else throw new Error('usage: build-binary | build-image | verify');
