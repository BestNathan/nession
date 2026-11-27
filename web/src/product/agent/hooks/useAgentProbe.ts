import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { orderByLatency } from '@/shared/lib/addressSelection';
import { probeResultsAtom, type AgentProbe } from '@/product/agent/state/probe';
import { probeScheduler, useProbeTargetStates, type ProbeCandidate } from '@/platform/probe';
import type { AddressLatency, ProbedAddress } from '@/types';

export interface AgentProbeInput {
  /** Agent whose candidates are being tested. A null id probes nothing. */
  agentId: string | null;
  /** Candidates to test. An empty list probes nothing (a relay attach has none). */
  addresses: ProbedAddress[];
  /**
   * Bump to measure again with the same inputs. A manual Re-test must refresh
   * unchanged addresses without requiring a remount (#4618).
   */
  reprobeKey?: number;
}

export interface AgentProbeController {
  /** The latest measurement for this agent, or null before one lands. */
  probe: AgentProbe | null;
  /** True while any of this agent's addresses is in flight. */
  probing: boolean;
}

function sameLatencies(a: AddressLatency[], b: AddressLatency[]): boolean {
  return a.length === b.length
    && a.every((entry, i) => entry.url === b[i].url && entry.latencyMs === b[i].latencyMs);
}

/**
 * Subscribe an Agent's candidate addresses to the shared probe scheduler
 * (#4618) and project its per-address results into `probeResultsAtom`.
 *
 * ## Why this is a bridge, not a measurement owner
 *
 * The React-free `ProbeScheduler` owns scheduling, cancellation, single-flight
 * and incremental publication. This hook only acquires/releases the target and
 * mirrors the published facts into the Jotai read model existing consumers
 * (Auto resolution, deep-link restore, the attach dialog) already read. There
 * is no component-owned batch and no `Promise.all` barrier: each address
 * settles on its own and the projection updates immediately.
 *
 * ## Why a fingerprint and not the array
 *
 * `addresses` is a fresh array on every render of the caller. Keying membership
 * on a string of what the probe actually reads (URL + probe endpoint) updates
 * the inventory exactly when the measurement would differ, and a `reprobeKey`
 * bump forces a fresh round even when nothing changed. The candidates are read
 * through a ref at fire time so the dependency list stays honest.
 */
export function useAgentProbe({ agentId, addresses, reprobeKey = 0 }: AgentProbeInput): AgentProbeController {
  const results = useAtomValue(probeResultsAtom);
  const setResults = useSetAtom(probeResultsAtom);
  const states = useProbeTargetStates(agentId);

  const fingerprint = addresses.map((a) => `${a.url}|${a.probe_url ?? ''}`).join(',');
  const candidates: ProbeCandidate[] = addresses.map((a) => ({
    addressId: a.url,
    wsUrl: a.url,
    probeUrl: a.probe_url ?? null,
  }));
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  // Hold a ref-counted lease for the lifetime of this subscriber. Several
  // subscribers (dialog preview + attached Session) share one logical target.
  useEffect(() => {
    if (!agentId) {
      return;
    }
    probeScheduler.acquireTarget({ targetId: agentId, kind: 'agent', addresses: [] });
    return () => probeScheduler.releaseTarget(agentId);
  }, [agentId]);

  // Set membership; the scheduler fences obsolete results and refreshes only
  // when the inventory actually changed.
  useEffect(() => {
    const current = candidatesRef.current;
    if (!agentId || current.length === 0) {
      return;
    }
    probeScheduler.registerTarget({ targetId: agentId, kind: 'agent', addresses: current });
  }, [agentId, fingerprint]);

  // A manual Re-test refreshes unchanged addresses too.
  useEffect(() => {
    if (!agentId || reprobeKey === 0) {
      return;
    }
    probeScheduler.refresh(agentId, 'manual');
  }, [agentId, reprobeKey]);

  // Project settled per-address results into the compatibility read model.
  // Pending/unknown addresses are omitted (not rendered as unreachable); the
  // last settled result is retained while a new round is pending.
  useEffect(() => {
    if (!agentId) {
      return;
    }
    const settled = states.filter((s) => s.reachability !== 'unknown');
    if (settled.length === 0) {
      // Absent means "nobody has looked"; do not write an empty projection that
      // a reader would mistake for a measurement.
      return;
    }
    const latencies = settled.map((s) => ({
      url: s.wsUrl,
      latencyMs: s.reachability === 'reachable' ? s.latencyMs : null,
    }));
    const orderedUrls = orderByLatency(latencies);
    const probedAt = settled.reduce((max, s) => Math.max(max, s.measuredAt ?? 0), 0) || Date.now();
    setResults((previous) => {
      const existing = previous.get(agentId);
      if (existing && existing.probedAt === probedAt && sameLatencies(existing.latencies, latencies)) {
        return previous;
      }
      const next = new Map(previous);
      next.set(agentId, { latencies, orderedUrls, probedAt });
      return next;
    });
  }, [agentId, states, setResults]);

  return {
    probe: agentId ? (results.get(agentId) ?? null) : null,
    probing: states.some((s) => s.probing),
  };
}
