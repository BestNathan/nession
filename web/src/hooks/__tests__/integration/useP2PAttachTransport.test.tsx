// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { useP2PAttachTransport } from '@/hooks/useP2PAttachTransport';
import { forcedRelayAtom } from '@/atoms/session';
import { useP2PConnection, type ConnectionState } from '@/hooks/useP2PConnection';
import type { AttachInfo } from '@/types';

vi.mock('@/hooks/useP2PConnection', () => ({
  useP2PConnection: vi.fn(() => null),
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

function wrapper(store: ReturnType<typeof createStore>) {
  return function JotaiWrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  };
}

function mockP2P(state: ConnectionState) {
  return {
    sendMessage: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    connectionState: state,
    reconnectAttempt: 0,
    close: vi.fn(),
    waitForConnection: vi.fn(() => Promise.resolve()),
  };
}

describe('useP2PAttachTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to relay when every auto candidate disconnects', async () => {
    const store = createStore();
    vi.mocked(useP2PConnection)
      .mockReturnValueOnce(mockP2P('connecting'))
      .mockReturnValue(mockP2P('disconnected'));

    const { rerender } = renderHook(
      () => useP2PAttachTransport({
        attachInfo: makeAttachInfo(),
        sessionName: 'test',
        orderedUrls: ['ws://dead/ws'],
        manualOverride: null,
      }),
      { wrapper: wrapper(store) },
    );

    rerender();

    await waitFor(() => {
      expect(store.get(forcedRelayAtom)).toBe(true);
    });
  });

  it('clears forced relay when manual override is selected', async () => {
    const store = createStore();
    store.set(forcedRelayAtom, true);

    const { rerender } = renderHook(
      ({ manualOverride }) => useP2PAttachTransport({
        attachInfo: makeAttachInfo(),
        sessionName: 'test',
        orderedUrls: ['ws://a/ws'],
        manualOverride,
      }),
      {
        wrapper: wrapper(store),
        initialProps: { manualOverride: null as string | null },
      },
    );

    await act(async () => {
      rerender({ manualOverride: 'ws://manual/ws' });
    });

    expect(store.get(forcedRelayAtom)).toBe(false);
  });
});
