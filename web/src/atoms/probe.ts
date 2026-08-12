// web/src/atoms/probe.ts
import { atom } from 'jotai';
import type { AddressLatency } from '../types';
import { agentIdAtom } from './session';

// Read the AgentProbe type from useAddressProbeCache to match existing contract.
// It has { latencies: AddressLatency[], orderedUrls: string[], probedAt: number }
interface AgentProbe {
  latencies: AddressLatency[];
  orderedUrls: string[];
  probedAt: number;
}

/** Per-agent browser-latency probe results, keyed by agent_id. */
export const probeResultsAtom = atom<Map<string, AgentProbe>>(new Map());

/** Latencies for the currently active agent (empty when none is active/unprobed). */
export const currentAgentLatenciesAtom = atom<AddressLatency[]>((get) => {
  const agentId = get(agentIdAtom);
  if (!agentId) { return []; }
  return get(probeResultsAtom).get(agentId)?.latencies ?? [];
});
