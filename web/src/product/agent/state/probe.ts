// web/src/product/agent/state/probe.ts
//
// Browser-latency probes, keyed by agent. They lived in `atoms/` while that
// directory was the default home for anything Jotai-shaped; the subject here is
// an Agent's addresses, so they belong to the Agent concept (#801 Phase 5).
import { atom } from 'jotai';
import type { AddressLatency } from '@/types';
import { agentIdAtom } from '@/product/session/state';

/**
 * One agent's browser-latency probe result (written by `useAgentProbe`).
 *
 * **An entry with all-null latencies is a measurement, not a transient
 * failure.** No address answered, and that is a fact about the network which a
 * reader has to be able to tell from "nobody has looked" — so it is written
 * rather than left absent. A reader that renders an absent entry and an
 * all-null one the same way will report untested addresses as unreachable.
 */
export interface AgentProbe {
  latencies: AddressLatency[];
  orderedUrls: string[];
  probedAt: number;
}

/**
 * Per-agent browser-latency probe results, keyed by agent_id.
 *
 * Written where a credential is available — the attach dialog, holding an
 * attach reply — because since #1013 the agent refuses an uncredentialed
 * upgrade and a probe without one measures nothing (#1091).
 */
export const probeResultsAtom = atom<Map<string, AgentProbe>>(new Map());

/** Latencies for the currently active agent (empty when none is active/unprobed). */
export const currentAgentLatenciesAtom = atom<AddressLatency[]>((get) => {
  const agentId = get(agentIdAtom);
  if (!agentId) { return []; }
  return get(probeResultsAtom).get(agentId)?.latencies ?? [];
});
