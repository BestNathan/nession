// web/src/hooks/useProbePolling.ts
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { Agent } from '../types';
import { probeResultsAtom } from '../atoms/probe';
import { testAddresses, orderByLatency } from '../services/addressSelection';

const POLL_INTERVAL_MS = 5 * 60_000;

/** Stable string that changes only when online agents or their addresses differ. */
function computeFingerprint(agents: Agent[]): string {
  return agents
    .filter((a) => a.status === 'online' && (a.addresses?.length ?? 0) > 0)
    .map((a) => {
      const urls = (a.addresses ?? []).map((addr) => addr.url).sort().join(',');
      return `${a.agent_id}:${a.status}:${urls}`;
    })
    .sort()
    .join('|');
}

/**
 * App-level per-agent address probe polling (issue #51).
 *
 * On mount and every 5 minutes, latency-probes every online agent's advertised
 * addresses directly from the browser (bare WebSocket handshake — no session,
 * no attach). Results are written to probeResultsAtom; consumers read
 * currentAgentLatenciesAtom / probeResultsAtom directly instead of a local
 * cache. Probes that fail are not cached (retried next cycle).
 *
 * `now` is injectable for tests; defaults to Date.now.
 */
export function useProbePolling(agents: Agent[], now: () => number = Date.now) {
  const setProbe = useSetAtom(probeResultsAtom);

  // Mirror the previous cacheRef: the reactive effect reads the latest map
  // without being re-created (which would reset the interval timer each render).
  const probeResults = useAtomValue(probeResultsAtom);
  const probeResultsRef = useRef(probeResults);
  probeResultsRef.current = probeResults;

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
    setProbe((prev) => {
      const next = new Map(prev);
      next.set(a.agent_id, { latencies, orderedUrls, probedAt: now() });
      return next;
    });
  }, [now, setProbe]);

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

  // Reactive probe: when agents arrive or addresses change after mount, probe
  // only the genuinely new/changed agents. The initial mount is covered by the
  // effect above — this one only fires on subsequent fingerprint changes.
  const fingerprint = useMemo(() => computeFingerprint(agents), [agents]);
  const prevFingerprintRef = useRef<string>(fingerprint);
  useEffect(() => {
    const prev = prevFingerprintRef.current;
    prevFingerprintRef.current = fingerprint;
    if (prev === fingerprint) { return; } // mount or no-op re-render

    // Build a set of agents that are currently online with addresses.
    const currentMap = new Map(
      agents
        .filter((a) => a.status === 'online' && (a.addresses?.length ?? 0) > 0)
        .map((a) => [a.agent_id, a] as const),
    );

    // Probe agents that aren't already cached (new or changed addresses).
    for (const [id, a] of currentMap) {
      if (!probeResultsRef.current.has(id)) {
        void probeAgent(a);
      }
    }
  }, [fingerprint, agents, probeAgent]);
}
