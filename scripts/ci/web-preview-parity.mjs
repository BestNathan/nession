#!/usr/bin/env node
// #1876 SC-06: verify a RUNNABLE Web dist, not just artifact checksums.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const web = path.join(root, 'web');
const dist = path.join(web, 'dist');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
async function allocatePort() {
  const server = createTcpServer();
  const port = await listen(server);
  await new Promise(r => server.close(r));
  return port;
}
async function wsHandshake(port) {
  const key = randomBytes(16).toString('base64');
  const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  return new Promise((resolve, reject) => {
    let received = '';
    const socket = connect(port, '127.0.0.1');
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('WebSocket handshake timed out')); }, 8000);
    function done(error) { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(); }
    socket.on('error', done);
    socket.on('connect', () => socket.write([
      'GET /ws?parity=1 HTTP/1.1', 'Host: 127.0.0.1:' + port,
      'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: ' + key, '', '',
    ].join('\r\n')));
    socket.on('data', (data) => {
      received += data.toString('utf8');
      if (received.includes('\r\n\r\n')) {
        const good = /^HTTP\/1\.1 101\b/.test(received) && received.toLowerCase().includes('sec-websocket-accept: ' + expected.toLowerCase());
        done(good ? null : new Error('WebSocket /ws proxy handshake mismatch: ' + received.slice(0, 300)));
      }
    });
  });
}
async function run() {
  if (!existsSync(path.join(dist, 'index.html'))) throw Error('no built dist/index.html');
  const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const pkg = JSON.parse(readFileSync(path.join(web, 'package.json'), 'utf8'));
  const fonts = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(x => x.startsWith('@fontsource')).sort();
  assert.ok(fonts.length, 'missing font packages');
  let upgradeSeen = false;
  const upgradedSockets = new Set();
  const backend = createServer((req, res) => {
    if (!req.url?.startsWith('/api/__nession_web_parity')) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'x-parity': 'backend' });
    res.end(JSON.stringify({ proxied: true, path: req.url }));
  });
  backend.on('upgrade', (req, socket) => {
    upgradedSockets.add(socket);
    socket.on('close', () => upgradedSockets.delete(socket));
    if (!req.url?.startsWith('/ws?parity=1')) { socket.destroy(); return; }
    upgradeSeen = true;
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  });
  const backendPort = await listen(backend);
  const port = await allocatePort();
  const preview = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: web, env: { ...process.env, NESSION_DEV_WS_PROXY: 'http://127.0.0.1:' + backendPort },
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  preview.stdout.on('data', data => { output += data.toString(); });
  preview.stderr.on('data', data => { output += data.toString(); });
  const base = 'http://127.0.0.1:' + port;
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (preview.exitCode != null) throw Error('vite preview exited: ' + output.slice(-1000));
      try { const response = await fetch(base + '/', { signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break; } }
      catch { /* preview startup */ }
      await sleep(200);
    }
    if (!ready) throw Error('vite preview readiness timeout: ' + output.slice(-1000));
    const html = await fetch(base + '/');
    assert.equal(html.status, 200);
    assert.equal(await html.text(), readFileSync(path.join(dist, 'index.html'), 'utf8'), 'served HTML differs from exact built dist');
    const api = await fetch(base + '/api/__nession_web_parity?source=dist');
    assert.equal(api.status, 200, '/api proxy did not respond');
    assert.equal(api.headers.get('x-parity'), 'backend', '/api did not reach backend');
    assert.deepEqual(await api.json(), { proxied: true, path: '/api/__nession_web_parity?source=dist' });
    await wsHandshake(port);
    assert.equal(upgradeSeen, true, 'WebSocket /ws did not reach backend');
    for (const font of fonts) {
      const file = 'licenses/' + font.replace(/[@/]/g, '-').replace(/^-/, '') + '.txt';
      const response = await fetch(base + '/' + file);
      assert.equal(response.status, 200, 'font license not served: ' + file);
      assert.equal(await response.text(), readFileSync(path.join(dist, file), 'utf8'), 'font license mismatch: ' + file);
    }
    console.log('WEB_PREVIEW_PARITY_V1 ' + JSON.stringify({ status: 'Pass', sha, html: true, api: true, ws: true, licenses: fonts.length }));
  } finally {
    try {
      if (process.platform !== 'win32' && preview.pid) process.kill(-preview.pid, 'SIGTERM');
      else preview.kill('SIGTERM');
    } catch { /* already exited */ }
    await Promise.race([new Promise(r => preview.once('exit', r)), sleep(2000)]);
    if (preview.exitCode == null) {
      try {
        if (process.platform !== 'win32' && preview.pid) process.kill(-preview.pid, 'SIGKILL');
        else preview.kill('SIGKILL');
      } catch { /* already exited */ }
    }
    for (const socket of upgradedSockets) socket.destroy();
    await new Promise(r => backend.close(r));
  }
}
run().catch(error => { console.error('WEB_PREVIEW_PARITY_V1 Fail ' + error.stack); process.exitCode = 1; });
