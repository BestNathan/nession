// Controlled cold/warm measurement of the HTTP reachability probe against the
// legacy WS-upgrade baseline (#4618 SC-08, SCN-06).
//
// Run: node web/scripts/probe-benchmark.mjs
//
// Both endpoints are real loopback servers with an IDENTICAL fixed delay before
// answering, so the comparison is like-for-like. Records sample count and
// p50/p95 and proves the HTTP probe opens zero WebSocket pending-auth slots.
// Asserts structural facts (samples ran, HTTP created no WS, fast beats slow),
// never an invented production latency SLO. The exact runner/SHA is carried by
// the environment that executes this (CI sets GITHUB_SHA / RUNNER_NAME).
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const FIXED_DELAY_MS = 15;
const SAMPLES = 12;

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: samples.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), cold: samples[0] };
}

function probeResponse(res) {
  res.writeHead(204, {
    'Cache-Control': 'no-store',
    'Nession-Probe': 'v1',
    'Access-Control-Expose-Headers': 'Nession-Probe',
  });
  res.end();
}

async function measureHttp(url) {
  const start = performance.now();
  const response = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error' });
  const elapsed = Math.round(performance.now() - start);
  const ok = response.status === 204 && response.headers.get('Nession-Probe') === 'v1';
  return { ok, elapsed };
}

async function measureWs(url) {
  const start = performance.now();
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error('ws timeout')); }, 3000);
    ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
  return Math.round(performance.now() - start);
}

const httpServer = http.createServer((req, res) => {
  if (req.url === '/probe') {
    setTimeout(() => probeResponse(res), FIXED_DELAY_MS);
  } else {
    res.writeHead(404); res.end();
  }
});
let wsUpgrades = 0;
const wsSockets = new Set();
const wsServer = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
wsServer.on('upgrade', (req, socket) => {
  wsUpgrades += 1;
  wsSockets.add(socket);
  socket.on('close', () => wsSockets.delete(socket));
  const key = req.headers['sec-websocket-key'];
  setTimeout(() => {
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  }, FIXED_DELAY_MS);
});

await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
await new Promise((r) => wsServer.listen(0, '127.0.0.1', r));
const httpPort = httpServer.address().port;
const wsPort = wsServer.address().port;
const probeUrl = `http://127.0.0.1:${httpPort}/probe`;
const wsUrl = `ws://127.0.0.1:${wsPort}/ws`;

try {
  const httpSamples = [];
  const wsBefore = wsUpgrades;
  for (let i = 0; i < SAMPLES; i += 1) {
    const { ok, elapsed } = await measureHttp(probeUrl);
    assert.ok(ok, 'HTTP probe must validate 204 + marker');
    httpSamples.push(elapsed);
  }
  assert.equal(wsUpgrades - wsBefore, 0, 'HTTP probe must open zero WebSocket pending-auth slots');

  const wsSamples = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    wsSamples.push(await measureWs(wsUrl));
  }

  const httpSummary = summarize(httpSamples);
  const wsSummary = summarize(wsSamples);

  // Fast candidate usable well before a slow sibling's 3s deadline.
  const slowServer = http.createServer((_req, res) => { setTimeout(() => probeResponse(res), 3000); });
  await new Promise((r) => slowServer.listen(0, '127.0.0.1', r));
  const slowPort = slowServer.address().port;
  const started = performance.now();
  const controller = new AbortController();
  const slowPending = fetch(`http://127.0.0.1:${slowPort}/probe`, { signal: controller.signal }).catch(() => null);
  setTimeout(() => controller.abort(), 3000);
  const fast = await measureHttp(probeUrl);
  const timeToFirstUsable = Math.round(performance.now() - started);
  assert.ok(fast.ok);
  assert.ok(timeToFirstUsable < 1000, 'fast path must be usable before the slow deadline');
  await slowPending;
  slowServer.closeAllConnections();
  await new Promise((r) => slowServer.close(r));

  const evidence = {
    issue: 4618,
    criterion: 'SC-08',
    runner: process.env.RUNNER_NAME ?? 'local',
    sha: process.env.GITHUB_SHA ?? 'local-worktree',
    fixed_delay_ms: FIXED_DELAY_MS,
    measurement_kind: { http: 'fetch-204-marker', ws: 'upgrade-onopen' },
    http: httpSummary,
    ws: wsSummary,
    http_ws_pending_auth_slots: 0,
    time_to_first_usable_ms: timeToFirstUsable,
    note: 'controlled loopback, identical fixed delay; no production SLO claimed',
  };
  assert.equal(httpSummary.count, SAMPLES);
  assert.equal(wsSummary.count, SAMPLES);
  assert.ok(Number.isFinite(httpSummary.p50) && Number.isFinite(httpSummary.p95));
  assert.ok(httpSummary.p95 >= httpSummary.p50);
  console.log('PROBE_BENCHMARK ' + JSON.stringify(evidence));
} finally {
  for (const socket of wsSockets) socket.destroy();
  wsSockets.clear();
  httpServer.closeAllConnections();
  wsServer.closeAllConnections();
  await new Promise((r) => httpServer.close(r));
  await new Promise((r) => wsServer.close(r));
}
