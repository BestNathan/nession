import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useP2PWithFallback } from '../useP2PWithFallback';
import { useP2PConnection } from '../useP2PConnection';
import type { AttachInfo } from '../../types';

// useP2PConnection depends on WebSocket — mock it out.
vi.mock('../useP2PConnection', () => ({
  useP2PConnection: vi.fn(() => ({
    sendMessage: vi.fn(),
    onMessage: vi.fn(() => vi.fn()),
    connectionState: 'connected',
    reconnectAttempt: 0,
    close: vi.fn(),
    waitForConnection: vi.fn(() => Promise.resolve()),
  })),
}));

function makeAttachInfo(overrides: Partial<AttachInfo> = {}): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent:test-session',
    agent_address: 'ws://agent:19090/ws',
    connection_token: 'token-123',
    addresses: [
      { url: 'ws://a/ws', label: 'LAN', network_type: 'lan', priority: 10, status: 'reachable' },
      { url: 'ws://b/ws', label: 'VPN', network_type: 'vpn', priority: 5, status: 'reachable' },
    ],
    ...overrides,
  };
}

describe('useP2PWithFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('forcedRelay', () => {
    it('returns forcedRelay=false when manualOverride is set (same render)', () => {
      const { result } = renderHook(
        ({ manualOverride }) =>
          useP2PWithFallback(makeAttachInfo(), 'test', {
            orderedUrls: ['ws://a/ws', 'ws://b/ws'],
            initialSelectedAddress: manualOverride,
          }),
        { initialProps: { manualOverride: null as string | null } },
      );

      // Start in auto mode — should use orderedUrls.
      expect(result.current.forcedRelay).toBe(false);
      expect(result.current.effectiveMode).toBe('p2p');
      expect(result.current.isSwitching).toBe(false);

      // Set a manual address — forcedRelay MUST be false on this same render.
      act(() => {
        result.current.setManualOverride('ws://manual/ws');
      });

      expect(result.current.manualOverride).toBe('ws://manual/ws');
      expect(result.current.forcedRelay).toBe(false);
      expect(result.current.effectiveMode).toBe('p2p');
    });

    it('returns isSwitching=true when manual address is selected and connection is not connected', () => {
      // Simulate connecting state.
      vi.mocked(useP2PConnection).mockReturnValue({
        sendMessage: vi.fn(),
        onMessage: vi.fn(() => vi.fn()),
        connectionState: 'connecting',
        reconnectAttempt: 0,
        close: vi.fn(),
        waitForConnection: vi.fn(() => Promise.resolve()),
      });

      const { result } = renderHook(() =>
        useP2PWithFallback(makeAttachInfo(), 'test', {
          orderedUrls: ['ws://a/ws'],
          initialSelectedAddress: 'ws://manual/ws',
        }),
      );

      expect(result.current.isSwitching).toBe(true);
    });

    it('returns isSwitching=false when manual address is selected and connection is connected', () => {
      vi.mocked(useP2PConnection).mockReturnValue({
        sendMessage: vi.fn(),
        onMessage: vi.fn(() => vi.fn()),
        connectionState: 'connected',
        reconnectAttempt: 0,
        close: vi.fn(),
        waitForConnection: vi.fn(() => Promise.resolve()),
      });

      const { result } = renderHook(() =>
        useP2PWithFallback(makeAttachInfo(), 'test', {
          orderedUrls: ['ws://a/ws'],
          initialSelectedAddress: 'ws://manual/ws',
        }),
      );

      expect(result.current.isSwitching).toBe(false);
    });
  });
});
