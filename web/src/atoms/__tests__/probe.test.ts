// web/src/atoms/__tests__/probe.test.ts
import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import { probeResultsAtom, currentAgentLatenciesAtom, type AgentProbe } from '../probe';
import { sessionIdAtom } from '../session';

describe('currentAgentLatenciesAtom', () => {
  it('returns empty when no session is active', () => {
    const store = createStore();
    store.set(sessionIdAtom, '');
    expect(store.get(currentAgentLatenciesAtom)).toEqual([]);
  });

  it('returns the probed latencies for the active agent', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent-1:dev');
    const probe: AgentProbe = {
      latencies: [{ url: 'ws://a/ws', latencyMs: 10 }],
      orderedUrls: ['ws://a/ws'],
      probedAt: 0,
    };
    store.set(probeResultsAtom, new Map([['agent-1', probe]]));
    expect(store.get(currentAgentLatenciesAtom)).toEqual(probe.latencies);
  });

  it('returns empty when the active agent has no probe yet', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent-1:dev');
    expect(store.get(currentAgentLatenciesAtom)).toEqual([]);
  });
});
