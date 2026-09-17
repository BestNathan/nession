import type { ProbedAddress, AddressLatency } from '../types';

/**
 * Measure connection latency to a candidate agent WebSocket by opening a bare
 * handshake and timing how long until `onopen`. No data is sent; the socket is
 * closed immediately once open (or on error/timeout).
 *
 * Resolves with `latencyMs` on success, or `null` when the handshake fails or
 * exceeds `timeoutMs`. Never rejects — callers treat null as "unreachable
 * from this browser".
 */
export function measureLatency(url: string, timeoutMs = 3_000): Promise<AddressLatency> {
  return new Promise((resolve) => {
    const start = performance.now();
    let settled = false;
    let ws: WebSocket | null = null;

    const finish = (latencyMs: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (ws) {
        const socket = ws;
        ws = null;
        socket.onerror = null;
        socket.onclose = null;
        if (socket.readyState === WebSocket.OPEN) {
          socket.onopen = null;
          try {
            socket.close();
          } catch {
            /* already closing */
          }
        } else if (socket.readyState === WebSocket.CONNECTING) {
          // Closing while CONNECTING makes Chrome log "closed before established".
          // Defer close until the handshake completes (or fails via onerror).
          socket.onopen = () => {
            socket.onopen = null;
            try {
              socket.close();
            } catch {
              /* already closing */
            }
          };
        }
      }
      resolve({ url, latencyMs });
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      ws = new WebSocket(url);
      ws.onopen = () => finish(Math.round(performance.now() - start));
      ws.onerror = () => finish(null);
      // A close before open (e.g. connection refused) also means failure.
      ws.onclose = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

/**
 * Latency-test EVERY candidate address from THIS browser, in parallel.
 *
 * The browser is the sole authority on what it can reach: reachability from the
 * server (the `status` field carried on each `ProbedAddress`) is a different
 * network vantage point and is deliberately NOT used to include/exclude
 * candidates here. Results preserve the input order; each carries the
 * browser-measured latency (`null` = unreachable from this browser).
 */
export function testAddresses(addresses: ProbedAddress[]): Promise<AddressLatency[]> {
  return Promise.all(addresses.map((a) => measureLatency(a.url)));
}

/**
 * Order browser-latency results best-first for connecting.
 *
 * Reachable (finite latency) addresses come first, lowest RTT winning. Addresses
 * that failed the browser handshake are appended last (a handshake test can
 * fail transiently even when a later real connection would succeed) — but they
 * are never dropped and server-side probe status is never consulted.
 */
export function orderByLatency(results: AddressLatency[]): string[] {
  const reachable = results.filter((r) => r.latencyMs !== null);
  const failed = results.filter((r) => r.latencyMs === null);
  reachable.sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
  return [...reachable.map((r) => r.url), ...failed.map((r) => r.url)];
}

/**
 * Convenience: browser-test a candidate list and return the best-first URL
 * order. Tests all addresses (never filters on server-side status).
 */
export async function orderAddressesByLatency(addresses: ProbedAddress[]): Promise<string[]> {
  if (addresses.length === 0) {
    return [];
  }
  const results = await testAddresses(addresses);
  return orderByLatency(results);
}
