import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, AddressLatency } from '../types';
import { testAddresses, orderByLatency } from '../services/addressSelection';

/** One agent's cached browser-latency probe. */
export interface AgentProbe {
  latencies: AddressLatency[];
  orderedUrls: string[];
  probedAt: number;
}

export interface AddressProbeCache {
  /** Read a fresh (< TTL) probe for an agent, or undefined. */
  getProbe: (agentId: string) => AgentProbe | undefined;
  /** Force a re-probe of one agent now. */
  refreshAgent: (agentId: string) => void;
}

const POLL_INTERVAL_MS = 5 * 60_000;
const TTL_MS = 5 * 60_000;

/**
 * App-level per-agent address probe cache (issue #51).
 *
 * On login and every 5 minutes, latency-probes every online agent's advertised
 * addresses directly from the browser (bare WebSocket handshake — no session,
 * no attach). AttachDialog reads this cache so attach never blocks on probing.
 * Probes that fail are not cached (retried next cycle); entries older than the
 * TTL are treated as stale and not returned.
 *
 * `now` is injectable for tests; defaults to Date.now.
 */
export function useAddressProbeCache(
  agents: Agent[],
  now: () => number = Date.now,
): AddressProbeCache {
  const [cache, setCache] = useState<Map<string, AgentProbe>>(new Map());

  // Keep the latest agents list in a ref so the interval callback reads current
  // data without being re-created (which would reset the timer each render).
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const probeAgent = useCallback(async (a: Agent) => {
    const addresses = a.addresses ?? [];
    if (a.status !== 'online' || addresses.length === 0) { return; }
    const latencies = await testAddresses(addresses);
    const reachable = latencies.some((l) => l.latencyMs !== null);
    if (!reachable) { return; } // failure — don't cache, retry next cycle
    const orderedUrls = orderByLatency(latencies);
    setCache((prev) => {
      const next = new Map(prev);
      next.set(a.agent_id, { latencies, orderedUrls, probedAt: now() });
      return next;
    });
  }, [now]);

  const probeAll = useCallback(() => {
    for (const a of agentsRef.current) {
      if (a.status === 'online' && (a.addresses?.length ?? 0) > 0) {
        void probeAgent(a);
      }
    }
  }, [probeAgent]);

  // Initial probe + 5-minute polling.
  useEffect(() => {
    probeAll();
    const timer = setInterval(probeAll, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [probeAll]);

  const getProbe = useCallback(
    (agentId: string): AgentProbe | undefined => {
      const entry = cache.get(agentId);
      if (!entry) { return undefined; }
      if (now() - entry.probedAt > TTL_MS) { return undefined; } // stale
      return entry;
    },
    [cache, now],
  );

  const refreshAgent = useCallback(
    (agentId: string) => {
      const a = agentsRef.current.find((x) => x.agent_id === agentId);
      if (a) { void probeAgent(a); }
    },
    [probeAgent],
  );

  return { getProbe, refreshAgent };
}
