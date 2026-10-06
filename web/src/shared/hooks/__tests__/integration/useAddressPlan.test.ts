import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAddressPlan } from '@/shared/hooks/useAddressPlan';
import type { AttachInfo, ProbedAddress } from '@/types';

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

describe('useAddressPlan (#1430)', () => {
  it('uses the manual override as a single-entry plan', () => {
    const info = attach({ addresses: [probed('ws://a/ws'), probed('ws://b/ws')] });
    const { result } = renderHook(() =>
      useAddressPlan(info, { orderedUrls: null, manualUrl: 'ws://b/ws' }),
    );
    expect(result.current).toEqual(['ws://b/ws']);
  });

  it('uses pre-resolved orderedUrls verbatim', () => {
    const info = attach({ addresses: [probed('ws://a/ws'), probed('ws://b/ws')] });
    const { result } = renderHook(() =>
      useAddressPlan(info, { orderedUrls: ['ws://b/ws', 'ws://a/ws'], manualUrl: null }),
    );
    expect(result.current).toEqual(['ws://b/ws', 'ws://a/ws']);
  });

  // Regression (issue #51): an EMPTY orderedUrls (probe cache not yet populated
  // / expired / transiently failed) must NOT resolve to a zero-URL plan. That
  // left activeUrl null → P2P never started and relay fallback never fired
  // (dead state: badge says P2P, nothing connects). Empty falls through to the
  // advertisement's own order.
  it('does not treat an empty orderedUrls as a resolved plan — falls back to candidates', () => {
    const info = attach({ addresses: [probed('ws://a/ws'), probed('ws://b/ws')] });
    const { result } = renderHook(() =>
      useAddressPlan(info, { orderedUrls: [], manualUrl: null }),
    );
    expect(result.current).toEqual(['ws://a/ws', 'ws://b/ws']);
  });

  it('empty orderedUrls with no candidates falls back to legacy agent_address', () => {
    const info = attach({ agent_address: 'ws://legacy/ws', addresses: [] });
    const { result } = renderHook(() =>
      useAddressPlan(info, { orderedUrls: [], manualUrl: null }),
    );
    expect(result.current).toEqual(['ws://legacy/ws']);
  });

  it('falls back to the legacy agent_address when no address list is present', () => {
    const info = attach({ agent_address: 'ws://legacy/ws', addresses: [] });
    const { result } = renderHook(() =>
      useAddressPlan(info, { orderedUrls: null, manualUrl: null }),
    );
    expect(result.current).toEqual(['ws://legacy/ws']);
  });

  /**
   * The point of #1430: with no pre-resolved order the plan IS the
   * advertisement's own order — synchronously, with no probe in the path.
   * That order is the agent's priority sort, so the first entry is the right
   * first attempt; the browser's measurement refines the *next* attach.
   */
  it('orders by the advertisement, synchronously, with no probe in the path', () => {
    const info = attach({
      addresses: [probed('ws://a/ws'), probed('ws://dead/ws', 'unreachable')],
    });
    const { result } = renderHook(() =>
      useAddressPlan(info, { orderedUrls: null, manualUrl: null }),
    );
    // Server-side 'unreachable' is still not a filter — the browser is the
    // authority — and nothing here waits to measure either address.
    expect(result.current).toEqual(['ws://a/ws', 'ws://dead/ws']);
  });

  it('carries every candidate into the plan, whatever the server thinks of it', () => {
    const info = attach({
      addresses: [probed('ws://lan/ws'), probed('ws://vpn/ws'), probed('ws://public/ws')],
    });
    const { result } = renderHook(() =>
      useAddressPlan(info, { orderedUrls: null, manualUrl: null }),
    );
    expect(result.current).toHaveLength(3);
  });

  it('is immediately ready with no urls for relay attaches', () => {
    const info = attach({ mode: 'relay' });
    const { result } = renderHook(() =>
      useAddressPlan(info, { orderedUrls: null, manualUrl: null }),
    );
    expect(result.current).toEqual([]);
  });

  it('resolves the same plan across re-renders (no effect, no churn)', () => {
    const info = attach({ addresses: [probed('ws://a/ws')] });
    const { result, rerender } = renderHook(() =>
      useAddressPlan(info, { orderedUrls: null, manualUrl: null }),
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
