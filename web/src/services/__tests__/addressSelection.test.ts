import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { measureLatency, orderAddressesByLatency } from '../addressSelection';
import type { ProbedAddress } from '../../types';

// ---------------------------------------------------------------------------
// Mock WebSocket — each URL opens or fails per a configured map.
// ---------------------------------------------------------------------------

const OriginalWebSocket = globalThis.WebSocket;

interface MockWs {
  url: string;
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  close: () => void;
}

/**
 * Configure per-URL behaviour: `openDelayMs` opens the socket after that delay;
 * `fail: true` fires onerror instead. Unlisted URLs open immediately.
 */
let behavior: Record<string, { openDelayMs?: number; fail?: boolean }> = {};

function setupMock() {
  behavior = {};
  function MockCtor(this: MockWs, url: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    self.url = url;
    self.onopen = null;
    self.onerror = null;
    self.onclose = null;
    self.close = vi.fn();

    const cfg = behavior[url] ?? {};
    setTimeout(() => {
      if (cfg.fail) {
        self.onerror?.(new Event('error'));
      } else {
        self.onopen?.(new Event('open'));
      }
    }, cfg.openDelayMs ?? 0);
  }
  globalThis.WebSocket = MockCtor as unknown as typeof WebSocket;
}

function probed(url: string, status: ProbedAddress['status'], priority = 10): ProbedAddress {
  return { url, network_type: 'lan', priority, status };
}

beforeEach(() => {
  vi.useFakeTimers();
  setupMock();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.WebSocket = OriginalWebSocket;
});

describe('measureLatency', () => {
  it('resolves with a latency on successful handshake', async () => {
    behavior['ws://a/ws'] = { openDelayMs: 5 };
    const p = measureLatency('ws://a/ws');
    await vi.advanceTimersByTimeAsync(10);
    const result = await p;
    expect(result.url).toBe('ws://a/ws');
    expect(result.latencyMs).not.toBeNull();
  });

  it('resolves with null when the handshake fails', async () => {
    behavior['ws://bad/ws'] = { fail: true };
    const p = measureLatency('ws://bad/ws');
    await vi.advanceTimersByTimeAsync(10);
    const result = await p;
    expect(result.latencyMs).toBeNull();
  });

  it('resolves with null on timeout', async () => {
    behavior['ws://slow/ws'] = { openDelayMs: 999_999 };
    const p = measureLatency('ws://slow/ws', 1_000);
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await p;
    expect(result.latencyMs).toBeNull();
  });
});

describe('orderAddressesByLatency', () => {
  it('keeps a browser-reachable address even if server marked it unreachable', async () => {
    // The server's probe is a different vantage point; the browser is the
    // authority. An address the server called unreachable but the browser CAN
    // reach must still be offered (and ranked by its browser latency).
    const addrs = [
      probed('ws://server-dead-browser-ok/ws', 'unreachable'),
      probed('ws://live/ws', 'reachable'),
    ];
    behavior['ws://server-dead-browser-ok/ws'] = { openDelayMs: 1 };
    behavior['ws://live/ws'] = { openDelayMs: 20 };
    const p = orderAddressesByLatency(addrs);
    await vi.advanceTimersByTimeAsync(50);
    const urls = await p;
    // Both reachable from the browser; the faster one (server-"dead") wins.
    expect(urls).toEqual(['ws://server-dead-browser-ok/ws', 'ws://live/ws']);
  });

  it('orders reachable addresses by measured latency', async () => {
    const addrs = [
      probed('ws://slow/ws', 'reachable'),
      probed('ws://fast/ws', 'reachable'),
    ];
    behavior['ws://slow/ws'] = { openDelayMs: 50 };
    behavior['ws://fast/ws'] = { openDelayMs: 5 };
    const p = orderAddressesByLatency(addrs);
    await vi.advanceTimersByTimeAsync(100);
    const urls = await p;
    expect(urls[0]).toBe('ws://fast/ws');
    expect(urls[1]).toBe('ws://slow/ws');
  });

  it('appends handshake-failed addresses after reachable ones', async () => {
    const addrs = [
      probed('ws://ok/ws', 'unknown'),
      probed('ws://flaky/ws', 'unknown'),
    ];
    behavior['ws://ok/ws'] = { openDelayMs: 5 };
    behavior['ws://flaky/ws'] = { fail: true };
    const p = orderAddressesByLatency(addrs);
    await vi.advanceTimersByTimeAsync(4_000);
    const urls = await p;
    expect(urls[0]).toBe('ws://ok/ws');
    expect(urls).toContain('ws://flaky/ws');
  });

  it('still returns browser-failed addresses as last-resort attempts', async () => {
    // Even when the browser handshake fails for all, they are returned (not
    // dropped) so the connection layer can still try them before relay — a
    // handshake probe can fail transiently. Server status is never consulted.
    const addrs = [probed('ws://x/ws', 'reachable'), probed('ws://y/ws', 'reachable')];
    behavior['ws://x/ws'] = { fail: true };
    behavior['ws://y/ws'] = { fail: true };
    const p = orderAddressesByLatency(addrs);
    await vi.advanceTimersByTimeAsync(10);
    const urls = await p;
    expect(urls).toHaveLength(2);
    expect(urls).toContain('ws://x/ws');
    expect(urls).toContain('ws://y/ws');
  });

  it('returns empty only for an empty candidate list', async () => {
    const urls = await orderAddressesByLatency([]);
    expect(urls).toEqual([]);
  });
});
