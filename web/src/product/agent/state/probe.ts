// web/src/product/agent/state/probe.ts
//
// Browser-latency probes, keyed by agent. They lived in `atoms/` while that
// directory was the default home for anything Jotai-shaped; the subject here is
// an Agent's addresses, so they belong to the Agent concept (#801 Phase 5).
import { atom } from 'jotai';
import type { AddressLatency } from '@/types';
import { agentIdAtom } from '@/product/session/state';

/** One agent's browser-latency probe result (written by useProbePolling). */
export interface AgentProbe {
  latencies: AddressLatency[];
  orderedUrls: string[];
  probedAt: number;
}

/** Per-agent browser-latency probe results, keyed by agent_id. */
export const probeResultsAtom = atom<Map<string, AgentProbe>>(new Map());

/**
 * One-shot forced re-probe request (AttachDialog "Re-test"). Written with the
 * target agent id; useProbePolling consumes it (probes the agent, resets to null).
 * `nonce` disambiguates repeated clicks on the same agent.
 */
export const probeRefreshRequestAtom = atom<{ agentId: string; nonce: number } | null>(null);

/** Latencies for the currently active agent (empty when none is active/unprobed). */
export const currentAgentLatenciesAtom = atom<AddressLatency[]>((get) => {
  const agentId = get(agentIdAtom);
  if (!agentId) { return []; }
  return get(probeResultsAtom).get(agentId)?.latencies ?? [];
});
