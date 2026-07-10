import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAddressPlan } from '../useAddressPlan';
import type { AttachInfo, ProbedAddress } from '../../types';

// Mock the latency ordering so the hook test is deterministic. The real
// implementation tests ALL addresses from the browser and never filters on
// server-side status; the mock returns every url in input order.
vi.mock('../../services/addressSelection', () => ({
  orderAddressesByLatency: vi.fn(async (addrs: ProbedAddress[]) => addrs.map((a) => a.url)),
}));

function attach(overrides: Partial<AttachInfo>): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent:sess',
    session_name: 'sess',
    ...overrides,
  };
}

function probed(url: string, status: ProbedAddress['status'] = 'reachable'): ProbedAddress {
  return { url, network_type: 'lan', priority: 10, status };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAddressPlan', () => {
  it('uses the manual override as a single-entry plan without latency testing', async () => {
    const info = attach({
      addresses: [probed('ws://a/ws'), probed('ws://b/ws')],
    });
    const { result } = renderHook(() =>
      useAddressPlan(info, { orderedUrls: null, manualUrl: 'ws://b/ws' }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.urls).toEqual(['ws://b/ws']);
  });

  it('uses pre-resolved orderedUrls verbatim (no re-testing)', async () => {
    const info = attach({ addresses: [probed('ws://a/ws'), probed('ws://b/ws')] });
    const { result } = renderHook(() =>
      useAddressPlan(info, { orderedUrls: ['ws://b/ws', 'ws://a/ws'], manualUrl: null }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.urls).toEqual(['ws://b/ws', 'ws://a/ws']);
  });

  it('falls back to the legacy agent_address when no address list is present', async () => {
    const info = attach({ agent_address: 'ws://legacy/ws', addresses: [] });
    const { result } = renderHook(() =>
      useAddressPlan(info, { orderedUrls: null, manualUrl: null }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.urls).toEqual(['ws://legacy/ws']);
  });

  it('auto-orders the candidate list by latency when not pre-resolved', async () => {
    const info = attach({
      addresses: [probed('ws://a/ws'), probed('ws://dead/ws', 'unreachable')],
    });
    const { result } = renderHook(() =>
      useAddressPlan(info, { orderedUrls: null, manualUrl: null }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    // Browser tests all addresses; server 'unreachable' is NOT a filter.
    expect(result.current.urls).toEqual(['ws://a/ws', 'ws://dead/ws']);
  });

  it('is immediately ready with no urls for relay attaches', async () => {
    const info = attach({ mode: 'relay' });
    const { result } = renderHook(() =>
      useAddressPlan(info, { orderedUrls: null, manualUrl: null }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.urls).toEqual([]);
  });
});
