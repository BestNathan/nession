#!/usr/bin/env node
// #3705 staging-only source-aligned ingress proof. Build the prebuilt Server
// image's real nginx/runtime-tools stage in CI (not a local developer build),
// mount the exact checked-out Server binary and entrypoints, then speak real MCP
// over HTTP and TLS through nginx. No production secrets or deployed resources.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = 'nession-3705-test-server-token';
const tag = 'nession-3705-nginx-test:' + process.pid;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-3705-ingress-'));
let running = null;
let serverProcess = null;
let serverOutput = '';
const results = [];

function command(name, args, timeout = 120000) {
  const result = spawnSync(name, args, {
    cwd: root, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 * 8,
    env: { ...process.env, RUSTC_WRAPPER: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(name + ' ' + args.join(' ') + ' failed: ' +
      String(result.error || result.stderr || result.stdout).slice(-4000));
  }
  return result.stdout.trim();
}
function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}
function request(port, method, body, headers = {}, tls = false) {
  const bytes = body ? JSON.stringify(body) : '';
  const transport = tls ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: '127.0.0.1', port, path: '/mcp', method, timeout: 12000,
      rejectUnauthorized: false,
      headers: {
        Accept: 'application/json, text/event-stream',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'Content-Length': Buffer.byteLength(bytes),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('MCP gateway timed out')));
    req.once('error', reject);
    req.end(bytes);
  });
}
function decoded(response) {
  try { return JSON.parse(response.text); } catch {}
  for (const line of response.text.split(/\r?\n/)) {
    if (line.startsWith('data: ')) {
      try { return JSON.parse(line.slice(6)); } catch {}
    }
  }
  throw new Error('Non-JSON MCP result (status ' + response.status + '): ' + response.text.slice(0, 500));
}
function rpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
}
async function startHostServer(backend, tls) {
  const out = path.join(dir, tls ? 'server-tls.toml' : 'server-plain.toml');
  const cfgEnv = {
    ...process.env, SERVER_AUTH_TOKEN: token,
    SERVER_LISTEN: '127.0.0.1:' + backend,
    NESSION_HOME: path.join(dir, 'host-data'),
    NESSION_MCP_ENABLED: 'true',
    TLS_CERT_PATH: tls ? path.join(dir, 'cert.pem') : '',
    TLS_KEY_PATH: tls ? path.join(dir, 'key.pem') : '',
  };
  const render = spawnSync('sh', [path.join(root, 'deploy/render-server-config.sh'), out], {
    cwd: root, encoding: 'utf8', env: cfgEnv, timeout: 15000,
  });
  assert.equal(render.status, 0, 'host Server config: ' + render.stderr);
  serverOutput = '';
  serverProcess = spawn(path.join(root, 'target/debug/nession-server'), [out], {
    cwd: dir, env: cfgEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [serverProcess.stdout, serverProcess.stderr]) {
    stream.on('data', (buffer) => {
      serverOutput = (serverOutput + buffer.toString('utf8')).slice(-4000);
    });
  }
  for (let i = 0; i < 100; i++) {
    if (serverProcess.exitCode !== null) {
      throw new Error('host Server exited: ' + serverOutput);
    }
    try {
      const response = await request(backend, 'POST', rpc('tools/list'), {
        Authorization: 'Bearer invalid',
      }, tls);
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('host Server did not start: ' + serverOutput);
}
function stopHostServer() {
  if (!serverProcess) return;
  assert.equal(serverOutput.includes(token), false, 'Server logs leaked bearer token');
  serverProcess.kill('SIGTERM');
  serverProcess = null;
}

function logTail() {
  if (!running) return '';
  const x = spawnSync('docker', ['logs', running], { encoding: 'utf8', timeout: 20000 });
  const log = String(x.stdout || '') + String(x.stderr || '');
  assert.equal(log.includes(token), false, 'container log leaked inbound MCP token');
  return log.slice(-1400);
}
async function startContainer(front, backend, tls = false, disable = false) {
  const env = [
    '-e', 'LISTEN_PORT=' + front,
    '-e', 'SERVER_LISTEN=127.0.0.1:' + backend,
    '-e', 'SERVER_BACKEND=127.0.0.1:' + backend,
    '-e', 'NESSION_MCP_ENABLED=' + (disable ? 'false' : 'true'),
    '-e', 'SERVER_AUTH_TOKEN=' + token,
    '-e', 'NESSION_HOME=/data',
  ];
  if (tls) env.push('-e', 'TLS_CERT_PATH=/certs/cert.pem', '-e', 'TLS_KEY_PATH=/certs/key.pem');
  const sourceDir = path.join(root, 'deploy');
  const binary = path.join(dir, 'server-stub.sh');
  // Keep failed containers available for docker logs until explicit teardown.
  const args = ['run', '-d', '--network', 'host',
    '-w', '/etc/nession', '-v', sourceDir + ':/mcp-deploy:ro',
    '-v', binary + ':/usr/local/bin/nession-server:ro',
    '-v', dir + ':/certs:ro', ...env, tag, 'sh', '-c',
    // The runtime-tools build stage has nginx but NOT the final image's
    // COPY-created /etc/nginx/templates directory. Create it in this test
    // container before projecting the real shipped nginx template.
    'set -e; mkdir -p /etc/nginx/templates; ' +
    'cp /mcp-deploy/nginx.conf.template /etc/nginx/templates/default.conf.template; ' +
    'cp /mcp-deploy/entrypoint-server.sh /entrypoint.sh; ' +
    'cp /mcp-deploy/render-server-config.sh /render-server-config.sh; ' +
    'cp /mcp-deploy/render-mcp-config.sh /render-mcp-config.sh; ' +
    'chmod +x /entrypoint.sh /render-server-config.sh /render-mcp-config.sh; ' +
    'exec /entrypoint.sh',
  ];
  running = command('docker', args, 40000);
  for (let i = 0; i < 100; i++) {
    try {
      const response = await request(tls ? 443 : front, 'POST',
        rpc('tools/list', undefined, 10), { Authorization: 'Bearer wrong' }, tls);
      if (disable || response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('real nginx/MCP endpoint never became ready; startup logs: ' + logTail());
}
function stopContainer() {
  if (!running) return;
  const id = running;
  running = null;
  // `docker rm -f` settles a live or already-exited process, without leaking
  // an ephemeral test container on the host or losing its logs before readback.
  const result = spawnSync('docker', ['rm', '-f', id], {
    encoding: 'utf8', timeout: 20000,
  });
  if (result.error || result.status !== 0) {
    throw new Error('could not clean up nginx test container ' + id + ': ' +
      String(result.error || result.stderr).slice(-1200));
  }
}
async function exercise(port, tls) {
  const opts = { Authorization: 'Bearer ' + token };
  const noAuth = await request(port, 'POST', rpc('initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'nginx-case', version: '1' },
  }), {}, tls);
  assert.equal(noAuth.status, 401, 'missing bearer must not receive HTML');
  assert.ok(!/<!doctype html/i.test(noAuth.text), 'unauthenticated MCP returned Web UI');
  const wrong = await request(port, 'POST', rpc('tools/list'), { Authorization: 'Bearer bad' }, tls);
  assert.equal(wrong.status, 401, 'incorrect bearer token must be refused');
  const badOrigin = await request(port, 'POST', rpc('tools/list'), {
    ...opts, Origin: 'https://attacker.example.invalid',
    'MCP-Protocol-Version': '2026-07-28',
  }, tls);
  assert.notEqual(badOrigin.status, 200, 'Origin policy bypassed by nginx');

  const init = await request(port, 'POST', rpc('initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'nginx-case', version: '1' },
  }), opts, tls);
  assert.equal(init.status, 200, 'legacy initialization: ' + init.text.slice(0, 500));
  assert.ok(decoded(init).result, 'no legacy initialize result');
  const session = init.headers['mcp-session-id'];
  assert.ok(typeof session === 'string' && session.length > 0, 'nginx stripped Mcp-Session-Id');
  const legacy = await request(port, 'POST', rpc('tools/list'), {
    ...opts, 'Mcp-Session-Id': session,
  }, tls);
  assert.equal(legacy.status, 200, 'legacy tools/list: ' + legacy.text.slice(0, 500));
  const tools = decoded(legacy).result.tools;
  assert.ok(tools.some((x) => x.name === 'nession_server_list_agents'), 'no Server Tool behind nginx');

  // Modern stateless MCP uses the protocol's envelope metadata AND the
  // method/name HTTP headers. This must match the official in-repository
  // protocol fixtures; the legacy session headers alone are not sufficient.
  const modernVersion = '2026-07-28';
  const modernMeta = {
    'io.modelcontextprotocol/protocolVersion': modernVersion,
    'io.modelcontextprotocol/clientInfo': { name: 'nginx-case', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const discovery = await request(port, 'POST', rpc('server/discover', {
    _meta: modernMeta,
  }), { ...opts, 'MCP-Protocol-Version': modernVersion,
    'Mcp-Method': 'server/discover' }, tls);
  assert.equal(discovery.status, 200,
    'modern discovery: ' + discovery.text.slice(0, 500));
  const supported = decoded(discovery).result.supportedVersions;
  assert.ok(supported.includes(modernVersion) && supported.includes('2025-03-26'),
    'modern discovery lost either advertised protocol version');

  const modernHeaders = {
    ...opts,
    'MCP-Protocol-Version': modernVersion,
    'Mcp-Method': 'tools/call',
    'Mcp-Name': 'nession_server_list_agents',
  };
  // Negative fixture: a malformed modern request is rejected *through*
  // nginx, not silently reinterpreted as a legacy request or static HTML.
  const missingMeta = await request(port, 'POST', rpc('tools/call', {
    name: 'nession_server_list_agents', arguments: {},
  }), modernHeaders, tls);
  assert.equal(missingMeta.status, 400,
    'modern missing metadata must fail closed through nginx');
  assert.ok(!/<!doctype html/i.test(missingMeta.text),
    'malformed MCP request unexpectedly served Web SPA');

  const modern = await request(port, 'POST', rpc('tools/call', {
    name: 'nession_server_list_agents', arguments: {}, _meta: modernMeta,
  }), modernHeaders, tls);
  assert.equal(modern.status, 200, 'modern Tool read: ' + modern.text.slice(0, 500));
  const result = decoded(modern).result;
  assert.notEqual(result?.isError, true, 'modern read failed');
  const agents = JSON.parse(result.content[0].text).agents;
  assert.ok(Array.isArray(agents), 'read did not reach canonical Server backend');
  results.push((tls ? 'TLS' : 'HTTP') + ': 401 bearer, Origin rejection, legacy session/list, modern safe read');

  const ended = await request(port, 'DELETE', undefined, {
    ...opts, 'Mcp-Session-Id': session,
  }, tls);
  assert.ok(ended.status < 300, 'nginx broke legacy DELETE lifecycle: ' + ended.status);
}
try {
  command('cargo', ['build', '-p', 'nession-server', '--bin', 'nession-server'], 900000);
  const stub = path.join(dir, 'server-stub.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 });
  command('docker', [
    'build', '--target', 'runtime-tools', '-f', 'Dockerfile.server.prebuilt', '-t', tag, '.',
  ], 900000);

  const plain = await ephemeralPort();
  const plainBackend = await ephemeralPort();
  await startHostServer(plainBackend, false);
  await startContainer(plain, plainBackend);
  await exercise(plain, false);
  logTail();
  stopContainer();
  stopHostServer();

  command('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    '-subj', '/CN=localhost',
  ]);
  const tlsFront = await ephemeralPort();
  const tlsBackend = await ephemeralPort();
  await startHostServer(tlsBackend, true);
  await startContainer(tlsFront, tlsBackend, true);
  await exercise(443, true);
  logTail();
  stopContainer();
  stopHostServer();

  console.log('MCP_IMAGE_INGRESS_TEST PASS: ' + results.join(' | '));
} finally {
  try { stopContainer(); } catch {}
  try { stopHostServer(); } catch {}
  try { command('docker', ['image', 'rm', '-f', tag], 20000); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}
