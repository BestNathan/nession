// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { probeResultsAtom, type AgentProbe } from '@/product/agent/state/probe';
import { useAgentProbe } from '@/product/agent/hooks/useAgentProbe';
import type { AddressLatency, ProbedAddress } from '@/types';

/**
 * `testAddresses` is the only thing mocked; `orderByLatency` is the real one.
 * The ordering a caller reads out of the atom is therefore the shipped rule,
 * not a stub that could agree with a wrong implementation.
 */
const { testAddressesMock } = vi.hoisted(() => ({ testAddressesMock: vi.fn() }));

vi.mock('@/shared/lib/addressSelection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/addressSelection')>();
  return { ...actual, testAddresses: testAddressesMock };
});

function probed(url: string): ProbedAddress {
  return { url, network_type: 'lan', priority: 10, status: 'reachable' };
}

/** A promise whose settlement this test decides. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function latency(url: string, latencyMs: number | null): AddressLatency {
  return { url, latencyMs };
}

function wrapper(store: ReturnType<typeof createStore>) {
  return function JotaiWrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  };
}

const CANDIDATES = [probed('ws://a/ws'), probed('ws://b/ws')];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useAgentProbe', () => {
  it('measures the candidates with the credential and caches the result', async () => {
    testAddressesMock.mockResolvedValue([latency('ws://a/ws', 20), latency('ws://b/ws', 5)]);
    const store = createStore();

    const { result } = renderHook(
      () => useAgentProbe({ agentId: 'agent-1', addresses: CANDIDATES, credential: 'tok' }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => expect(result.current.probing).toBe(false));

    expect(testAddressesMock).toHaveBeenCalledWith(CANDIDATES, { credential: 'tok' });
    expect(store.get(probeResultsAtom).get('agent-1')).toMatchObject({
      orderedUrls: ['ws://b/ws', 'ws://a/ws'],
    });
  });

  /**
   * The inversion of the old poll's `if (!reachable) return`.
   *
   * `orderByLatency` never drops a failed address, so "all failed" is a
   * measurement a reader must be able to tell from "never measured". Refusing to
   * cache it makes an absence do a result's work, and every reader then renders
   * an untested address as unreachable — which is #1091's visible half.
   */
  it('caches a total failure rather than leaving the entry absent', async () => {
    testAddressesMock.mockResolvedValue([latency('ws://a/ws', null), latency('ws://b/ws', null)]);
    const store = createStore();

    const { result } = renderHook(
      () => useAgentProbe({ agentId: 'agent-1', addresses: CANDIDATES, credential: 'tok' }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => expect(result.current.probe).not.toBeNull());

    const cached = store.get(probeResultsAtom).get('agent-1');
    expect(cached?.latencies.every((l) => l.latencyMs === null)).toBe(true);
    expect(cached?.orderedUrls).toEqual(['ws://a/ws', 'ws://b/ws']);
  });

  it('probes nothing without a credential', async () => {
    const store = createStore();

    renderHook(
      () => useAgentProbe({ agentId: 'agent-1', addresses: CANDIDATES, credential: undefined }),
      { wrapper: wrapper(store) },
    );

    await Promise.resolve();
    expect(testAddressesMock).not.toHaveBeenCalled();
    expect(store.get(probeResultsAtom).size).toBe(0);
  });

  it('probes nothing with no candidates, and nothing with no agent', async () => {
    const store = createStore();

    renderHook(
      () => useAgentProbe({ agentId: 'agent-1', addresses: [], credential: 'tok' }),
      { wrapper: wrapper(store) },
    );
    renderHook(
      () => useAgentProbe({ agentId: null, addresses: CANDIDATES, credential: 'tok' }),
      { wrapper: wrapper(store) },
    );

    await Promise.resolve();
    expect(testAddressesMock).not.toHaveBeenCalled();
  });

  /**
   * A re-attach re-mints the credential, which is the fingerprint moving — so
   * "Re-test" re-measures because the dialog re-fetched attach info, not
   * because something explicitly asked for a second measurement.
   */
  it('re-measures when the credential changes', async () => {
    testAddressesMock.mockResolvedValue([latency('ws://a/ws', 20), latency('ws://b/ws', 5)]);
    const store = createStore();

    const { rerender } = renderHook(
      ({ credential }: { credential: string }) =>
        useAgentProbe({ agentId: 'agent-1', addresses: CANDIDATES, credential }),
      { wrapper: wrapper(store), initialProps: { credential: 'first' } },
    );
    await waitFor(() => expect(testAddressesMock).toHaveBeenCalledTimes(1));

    testAddressesMock.mockResolvedValue([latency('ws://a/ws', 3), latency('ws://b/ws', 40)]);
    rerender({ credential: 'second' });

    await waitFor(() => expect(testAddressesMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(store.get(probeResultsAtom).get('agent-1')?.orderedUrls).toEqual([
        'ws://a/ws',
        'ws://b/ws',
      ]),
    );
    expect(testAddressesMock).toHaveBeenLastCalledWith(CANDIDATES, { credential: 'second' });
  });

  it('does not re-probe when only the array identity changes', async () => {
    testAddressesMock.mockResolvedValue([latency('ws://a/ws', 20), latency('ws://b/ws', 5)]);
    const store = createStore();

    const { rerender } = renderHook(
      ({ addresses }: { addresses: ProbedAddress[] }) =>
        useAgentProbe({ agentId: 'agent-1', addresses, credential: 'tok' }),
      { wrapper: wrapper(store), initialProps: { addresses: CANDIDATES } },
    );
    await waitFor(() => expect(testAddressesMock).toHaveBeenCalledTimes(1));

    // Same content, new array — a caller re-rendering must not re-measure.
    rerender({ addresses: [probed('ws://a/ws'), probed('ws://b/ws')] });

    await Promise.resolve();
    expect(testAddressesMock).toHaveBeenCalledTimes(1);
  });

  /**
   * StrictMode mounts, cleans up and mounts again, so two measurements overlap
   * from the first render. The newest must win — the older one resolving last is
   * exactly the case a `cancelled` boolean gets wrong.
   */
  it('lets a newer measurement win even when an older one resolves later', async () => {
    const first = deferred<AddressLatency[]>();
    const second = deferred<AddressLatency[]>();
    testAddressesMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = createStore();

    const { rerender } = renderHook(
      ({ credential }: { credential: string }) =>
        useAgentProbe({ agentId: 'agent-1', addresses: CANDIDATES, credential }),
      { wrapper: wrapper(store), initialProps: { credential: 'first' } },
    );
    rerender({ credential: 'second' });

    // The newer measurement resolves first, the older one second.
    second.resolve([latency('ws://a/ws', 1), latency('ws://b/ws', 99)]);
    await waitFor(() =>
      expect(store.get(probeResultsAtom).get('agent-1')?.latencies[0].latencyMs).toBe(1),
    );

    first.resolve([latency('ws://a/ws', 500), latency('ws://b/ws', 600)]);
    await Promise.resolve();
    await Promise.resolve();

    expect(store.get(probeResultsAtom).get('agent-1')?.latencies[0].latencyMs).toBe(1);
  });

  it('does not write a result that arrives after unmount', async () => {
    const pending = deferred<AddressLatency[]>();
    testAddressesMock.mockReturnValue(pending.promise);
    const store = createStore();

    const { unmount } = renderHook(
      () => useAgentProbe({ agentId: 'agent-1', addresses: CANDIDATES, credential: 'tok' }),
      { wrapper: wrapper(store) },
    );
    unmount();

    pending.resolve([latency('ws://a/ws', 5)]);
    await Promise.resolve();
    await Promise.resolve();

    expect(store.get(probeResultsAtom).size).toBe(0);
  });

  it('surfaces an entry already in the atom before measuring', async () => {
    const seeded: AgentProbe = {
      latencies: [latency('ws://a/ws', 7)],
      orderedUrls: ['ws://a/ws'],
      probedAt: 1,
    };
    const store = createStore();
    store.set(probeResultsAtom, new Map([['agent-1', seeded]]));
    testAddressesMock.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(
      () => useAgentProbe({ agentId: 'agent-1', addresses: CANDIDATES, credential: 'tok' }),
      { wrapper: wrapper(store) },
    );

    expect(result.current.probe).toEqual(seeded);
  });
});
