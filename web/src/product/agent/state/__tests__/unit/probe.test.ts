import { describe, it, expect } from 'vitest';
import { createStore } from 'jotai';
import { probeResultsAtom, type AgentProbe } from '@/product/agent/state';

describe('probeResultsAtom', () => {
  it('starts empty', () => {
    const store = createStore();
    expect(store.get(probeResultsAtom).size).toBe(0);
  });

  it('stores per-agent probe results', () => {
    const store = createStore();
    const probe: AgentProbe = {
      latencies: [{ url: 'ws://a/ws', latencyMs: 10 }],
      orderedUrls: ['ws://a/ws'],
      probedAt: 0,
    };
    store.set(probeResultsAtom, new Map([['agent-1', probe]]));
    expect(store.get(probeResultsAtom).get('agent-1')).toEqual(probe);
  });
});
