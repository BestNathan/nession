// Controlled cold/warm measurement of the HTTP reachability probe against the
// legacy WS-upgrade baseline (#4618 SC-08, SCN-06).
//
// Both endpoints are real loopback servers with an IDENTICAL fixed delay before
// answering, so the comparison is like-for-like. This records sample count and
// p50/p95 and proves the HTTP probe opens zero WebSocket pending-auth slots. It
// asserts structural facts (samples ran, HTTP created no WS, fast beats slow),
// never an invented production latency SLO. The exact runner/SHA is carried by
// the CI environment that executes this at the PR head.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import type { Socket } from 'node:net';
import { measureHttpProbe } from '../../httpProbe';
import { measureLatency } from '@/shared/lib/addressSelection';

const FIXED_DELAY_MS = 15;
const SAMPLES = 12;

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(samples: number[]): { count: number; p50: number; p95: number; cold: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: samples.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), cold: samples[0] };
}

describe('probe benchmark (#4618 SC-08)', () => {
  let httpServer: http.Server;
  let wsServer: http.Server;
  let httpPort = 0;
  let wsPort = 0;
  let wsUpgrades = 0;
  let httpRequests = 0;
  const wsSockets = new Set<Socket>();

  beforeAll(async () => {
    httpServer = http.createServer((req, res) => {
      if (req.url === '/probe') {
        httpRequests += 1;
        setTimeout(() => {
          res.writeHead(204, {
            'Cache-Control': 'no-store',
            'Nession-Probe': 'v1',
            'Access-Control-Expose-Headers': 'Nession-Probe',
          });
          res.end();
        }, FIXED_DELAY_MS);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    wsServer = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    wsServer.on('upgrade', (req, socket) => {
      wsUpgrades += 1;
      wsSockets.add(socket);
      socket.on('close', () => wsSockets.delete(socket));
      const key = req.headers['sec-websocket-key'] as string;
      setTimeout(() => {
        const accept = crypto
          .createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n'
          + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
          + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
      }, FIXED_DELAY_MS);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => wsServer.listen(0, '127.0.0.1', resolve));
    httpPort = (httpServer.address() as { port: number }).port;
    wsPort = (wsServer.address() as { port: number }).port;
  });

  afterAll(async () => {
    // Upgraded WS sockets detach from the server's connection list; destroy
    // them explicitly so close() returns.
    for (const socket of wsSockets) {
      socket.destroy();
    }
    wsSockets.clear();
    httpServer.closeAllConnections();
    wsServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await new Promise<void>((resolve) => wsServer.close(() => resolve()));
  });

  it('records comparable cold/warm HTTP vs WS samples and zero WS slots for HTTP', async () => {
    const probeUrl = `http://127.0.0.1:${httpPort}/probe`;
    const wsUrl = `ws://127.0.0.1:${wsPort}/ws`;

    const httpSamples: number[] = [];
    const wsUpgradesBeforeHttp = wsUpgrades;
    for (let i = 0; i < SAMPLES; i += 1) {
      const result = await measureHttpProbe(probeUrl);
      expect(result.reachability).toBe('reachable');
      expect(typeof result.latencyMs).toBe('number');
      httpSamples.push(result.latencyMs as number);
    }
    // The HTTP probe opened no WebSocket: zero pending-auth slots on the peer.
    expect(wsUpgrades - wsUpgradesBeforeHttp).toBe(0);
    expect(httpRequests).toBe(SAMPLES);

    const wsSamples: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const result = await measureLatency(wsUrl, { timeoutMs: 3_000 });
      expect(result.latencyMs).not.toBeNull();
      wsSamples.push(result.latencyMs as number);
    }

    const http = summarize(httpSamples);
    const ws = summarize(wsSamples);
    const evidence = {
      issue: 4618,
      criterion: 'SC-08',
      runner: process.env.RUNNER_NAME ?? 'local',
      sha: process.env.GITHUB_SHA ?? 'local-worktree',
      fixed_delay_ms: FIXED_DELAY_MS,
      measurement_kind: { http: 'fetch-204-marker', ws: 'upgrade-onopen' },
      http,
      ws,
      http_ws_pending_auth_slots: 0,
      note: 'controlled loopback, identical fixed delay; no production SLO claimed',
    };
    console.log('PROBE_BENCHMARK ' + JSON.stringify(evidence));

    expect(http.count).toBe(SAMPLES);
    expect(ws.count).toBe(SAMPLES);
    expect(Number.isFinite(http.p50)).toBe(true);
    expect(Number.isFinite(http.p95)).toBe(true);
    expect(http.p95).toBeGreaterThanOrEqual(http.p50);
  }, 30_000);

  it('a fast candidate settles before a slow sibling deadline (time-to-first-usable)', async () => {
    // A delayed server stands in for the slow sibling; the fast probe must
    // publish usable reachability well before the slow 3s deadline.
    const slowServer = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(204, { 'Nession-Probe': 'v1' });
        res.end();
      }, 3_000);
    });
    await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
    const slowPort = (slowServer.address() as { port: number }).port;
    try {
      const fastUrl = `http://127.0.0.1:${httpPort}/probe`;
      const slowUrl = `http://127.0.0.1:${slowPort}/probe`;
      const started = performance.now();
      const slowPending = measureHttpProbe(slowUrl, { deadlineMs: 3_000 });
      const fast = await measureHttpProbe(fastUrl);
      const timeToFirstUsable = performance.now() - started;
      expect(fast.reachability).toBe('reachable');
      // The fast path is usable far sooner than the slow sibling's deadline.
      expect(timeToFirstUsable).toBeLessThan(1_000);
      const slow = await slowPending;
      expect(slow.failureReason).toBe('timeout');
    } finally {
      slowServer.closeAllConnections();
      await new Promise<void>((resolve) => slowServer.close(() => resolve()));
    }
  }, 30_000);
});
