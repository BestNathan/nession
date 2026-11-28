// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { probeResultsAtom } from '@/product/agent/state/probe';
import { useAgentProbe } from '@/product/agent/hooks/useAgentProbe';
import { probeScheduler } from '@/platform/probe';
import type { ProbedAddress } from '@/types';

/**
 * The bridge delegates measurement to the shared React-free scheduler; these
 * tests drive the real scheduler with a controlled `fetch` double and a fake
 * clock, and assert what the bridge publishes into the compatibility read model.
 * Per-address scheduling/fences are proven in ProbeScheduler.test.ts.
 */

interface FetchCall {
  url: string;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

const control = vi.hoisted(() => ({ calls: [] as FetchCall[] }));

function probeResponse(): Response {
  return {
    status: 204,
    ok: true,
    type: 'cors',
    headers: new Headers({ 'Nession-Probe': 'v1' }),
  } as unknown as Response;
}

function probed(url: string, probeUrl: string): ProbedAddress {
  return { url, network_type: 'lan', priority: 10, status: 'unknown', probe_url: probeUrl };
}

function wrapper(store: ReturnType<typeof createStore>) {
  return function JotaiWrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  };
}

const CANDIDATES = [probed('ws://a/ws', 'http://a/probe'), probed('ws://b/ws', 'http://b/probe')];

async function fireDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500);
}

function settle(url: string, ok: boolean): void {
  const call = control.calls.find((c) => c.url === url);
  if (!call) {
    throw new Error(`no fetch for ${url}`);
  }
  if (ok) {
    call.resolve(probeResponse());
  } else {
    call.reject(new TypeError('Failed to fetch'));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  control.calls.length = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>((resolve, reject) => {
    control.calls.push({ url, resolve, reject });
  })));
});

afterEach(() => {
  probeScheduler.unregisterTarget('agent-1');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useAgentProbe bridge (#4618)', () => {
  it('registers the target and projects settled results into the atom', async () => {
    const store = createStore();
    const { result, unmount } = renderHook(
      () => useAgentProbe({ agentId: 'agent-1', addresses: CANDIDATES }),
      { wrapper: wrapper(store) },
    );
    await fireDebounce();
    expect(control.calls.map((c) => c.url).sort()).toEqual(['http://a/probe', 'http://b/probe']);
    settle('http://a/probe', true);
    settle('http://b/probe', true);
    await vi.advanceTimersByTimeAsync(0);

    const cached = store.get(probeResultsAtom).get('agent-1');
    expect(cached?.latencies.map((l) => l.url).sort()).toEqual(['ws://a/ws', 'ws://b/ws']);
    expect(cached?.orderedUrls).toHaveLength(2);
    expect(result.current.probing).toBe(false);
    unmount();
  });

  it('caches a total failure rather than leaving the entry absent', async () => {
    const store = createStore();
    const { unmount } = renderHook(
      () => useAgentProbe({ agentId: 'agent-1', addresses: CANDIDATES }),
      { wrapper: wrapper(store) },
    );
    await fireDebounce();
    settle('http://a/probe', false);
    settle('http://b/probe', false);
    await vi.advanceTimersByTimeAsync(0);

    const cached = store.get(probeResultsAtom).get('agent-1');
    expect(cached?.latencies.every((l) => l.latencyMs === null)).toBe(true);
    expect(cached?.orderedUrls).toEqual(['ws://a/ws', 'ws://b/ws']);
    unmount();
  });

  it('probes nothing with no candidates, and nothing with no agent', async () => {
    const store = createStore();
    const h1 = renderHook(() => useAgentProbe({ agentId: 'agent-1', addresses: [] }), { wrapper: wrapper(store) });
    const h2 = renderHook(() => useAgentProbe({ agentId: null, addresses: CANDIDATES }), { wrapper: wrapper(store) });
    await fireDebounce();
    expect(control.calls).toHaveLength(0);
    h1.unmount();
    h2.unmount();
  });

  it('refreshes unchanged addresses when the caller bumps reprobeKey', async () => {
    const store = createStore();
    const { rerender, unmount } = renderHook(
      ({ reprobeKey }: { reprobeKey: number }) => useAgentProbe({ agentId: 'agent-1', addresses: CANDIDATES, reprobeKey }),
      { wrapper: wrapper(store), initialProps: { reprobeKey: 0 } },
    );
    await fireDebounce();
    settle('http://a/probe', true);
    settle('http://b/probe', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.calls).toHaveLength(2);

    rerender({ reprobeKey: 1 });
    await fireDebounce();
    expect(control.calls).toHaveLength(4); // a fresh round for the same addresses
    unmount();
  });

  it('does not re-probe when only the array identity changes', async () => {
    const store = createStore();
    const { rerender, unmount } = renderHook(
      ({ addresses }: { addresses: ProbedAddress[] }) => useAgentProbe({ agentId: 'agent-1', addresses }),
      { wrapper: wrapper(store), initialProps: { addresses: CANDIDATES } },
    );
    await fireDebounce();
    settle('http://a/probe', true);
    settle('http://b/probe', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.calls).toHaveLength(2);

    rerender({ addresses: [probed('ws://a/ws', 'http://a/probe'), probed('ws://b/ws', 'http://b/probe')] });
    await fireDebounce();
    expect(control.calls).toHaveLength(2);
    unmount();
  });

  it('publishes incrementally: a fast address lands before the slow one settles', async () => {
    const store = createStore();
    const { unmount } = renderHook(
      () => useAgentProbe({ agentId: 'agent-1', addresses: CANDIDATES }),
      { wrapper: wrapper(store) },
    );
    await fireDebounce();
    settle('http://a/probe', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get(probeResultsAtom).get('agent-1')?.latencies.map((l) => l.url)).toEqual(['ws://a/ws']);

    settle('http://b/probe', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get(probeResultsAtom).get('agent-1')?.latencies).toHaveLength(2);
    unmount();
  });

  it('does not write a result that arrives after unmount', async () => {
    const store = createStore();
    const { unmount } = renderHook(
      () => useAgentProbe({ agentId: 'agent-1', addresses: CANDIDATES }),
      { wrapper: wrapper(store) },
    );
    await fireDebounce();
    unmount(); // releases the target before any probe settles
    settle('http://a/probe', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get(probeResultsAtom).size).toBe(0);
  });
});
