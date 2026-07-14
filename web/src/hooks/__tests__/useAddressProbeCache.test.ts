import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAddressProbeCache } from '../useAddressProbeCache';
import type { Agent } from '../../types';

vi.mock('../../services/addressSelection', () => ({
  testAddresses: vi.fn(async (addrs: { url: string }[]) =>
    addrs.map((a) => ({ url: a.url, latencyMs: 42 })),
  ),
  orderByLatency: (results: { url: string; latencyMs: number | null }[]) =>
    results.map((r) => r.url),
}));

function agent(id: string, urls: string[]): Agent {
  return {
    agent_id: id, hostname: id, ip_address: '10.0.0.1', port: 8080,
    status: 'online', session_count: 0, last_heartbeat: new Date().toISOString(),
    addresses: urls.map((url) => ({
      url, network_type: 'lan' as const, priority: 0, status: 'unknown' as const,
    })),
  };
}

describe('useAddressProbeCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('probes online agents and caches per-agent results', async () => {
    const agents = [agent('a1', ['ws://x/ws'])];
    const { result } = renderHook(() => useAddressProbeCache(agents));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const probe = result.current.getProbe('a1');
    expect(probe?.orderedUrls).toEqual(['ws://x/ws']);
    expect(probe?.latencies[0].latencyMs).toBe(42);
  });

  it('getProbe returns undefined for an unprobed agent', async () => {
    const { result } = renderHook(() => useAddressProbeCache([]));
    expect(result.current.getProbe('missing')).toBeUndefined();
  });

  it('re-probes on the 5-minute interval', async () => {
    const { testAddresses } = await import('../../services/addressSelection');
    const agents = [agent('a1', ['ws://x/ws'])];
    renderHook(() => useAddressProbeCache(agents));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const firstCalls = (testAddresses as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect((testAddresses as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThan(firstCalls);
  });
});
