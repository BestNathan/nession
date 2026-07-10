import type { ProbedAddress, AddressLatency } from '../types';

/**
 * Measure connection latency to a candidate agent WebSocket by opening a bare
 * handshake and timing how long until `onopen`. No data is sent; the socket is
 * closed immediately once open (or on error/timeout).
 *
 * Resolves with `latencyMs` on success, or `null` when the handshake fails or
 * exceeds `timeoutMs`. Never rejects — callers treat null as "unreachable".
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
        // Detach handlers before closing so the close doesn't re-enter finish.
        ws.onopen = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* already closing */
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
 * Order candidate addresses best-first for auto-connect.
 *
 * Latency-tests every non-`unreachable` address in parallel, then sorts:
 * reachable-by-latency first (lowest RTT wins), then untested/failed by their
 * server-probe priority. Server-probed `unreachable` addresses are dropped
 * entirely (they cost a doomed connection attempt).
 *
 * Returns the ordered list of URLs to try. Empty when nothing is worth trying
 * (caller then falls back to relay).
 */
export async function orderAddressesByLatency(
  addresses: ProbedAddress[],
): Promise<string[]> {
  // Skip addresses the server already knows are dead.
  const candidates = addresses.filter((a) => a.status !== 'unreachable');
  if (candidates.length === 0) {
    return [];
  }

  const results = await Promise.all(
    candidates.map((a) => measureLatency(a.url)),
  );

  const byUrl = new Map(candidates.map((a) => [a.url, a]));
  const reachable: AddressLatency[] = [];
  const failed: ProbedAddress[] = [];
  for (const r of results) {
    if (r.latencyMs !== null) {
      reachable.push(r);
    } else {
      const addr = byUrl.get(r.url);
      if (addr) {
        failed.push(addr);
      }
    }
  }

  reachable.sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
  failed.sort((a, b) => a.priority - b.priority);

  // Reachable (by measured latency) first, then failed ones as last-resort
  // attempts (the handshake test can fail transiently even when a later real
  // connection would succeed).
  return [...reachable.map((r) => r.url), ...failed.map((f) => f.url)];
}
