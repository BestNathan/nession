// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { useP2PAttachTransport } from '@/hooks/useP2PAttachTransport';
import { useSessionRuntime } from '@/hooks/useSessionRuntime';
import type { AttachInfo } from '@/types';

vi.mock('@/hooks/useSessionRuntime', () => ({
  useSessionRuntime: vi.fn(() => ({
    addressPlan: { ready: true, urls: ['ws://a/ws'] },
    activeUrl: 'ws://a/ws',
    p2pConnection: null,
    p2pState: 'disconnected' as const,
    waitingForAddressPlan: false,
    fileOps: null,
    runtime: null,
  })),
}));

function makeAttachInfo(): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent:test',
    agent_address: 'ws://a/ws',
    connection_token: 'token',
  };
}

function wrapper(store: ReturnType<typeof createStore>) {
  return function JotaiWrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  };
}

describe('useP2PAttachTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to useSessionRuntime with transportFirst flag', () => {
    const store = createStore();
    renderHook(
      () => useP2PAttachTransport({
        attachInfo: makeAttachInfo(),
        sessionName: 'test',
        orderedUrls: ['ws://a/ws'],
        manualOverride: null,
        transportFirst: true,
      }),
      { wrapper: wrapper(store) },
    );

    expect(useSessionRuntime).toHaveBeenCalledWith({ transportFirst: true, configOwner: true });
  });

  it('returns runtime transport fields', () => {
    const store = createStore();
    const { result } = renderHook(
      () => useP2PAttachTransport({
        attachInfo: makeAttachInfo(),
        sessionName: 'test',
        orderedUrls: ['ws://a/ws'],
        manualOverride: null,
      }),
      { wrapper: wrapper(store) },
    );

    expect(result.current.activeUrl).toBe('ws://a/ws');
    expect(result.current.p2pState).toBe('disconnected');
    expect(result.current.waitingForAddressPlan).toBe(false);
  });
});
