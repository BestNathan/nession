// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createElement, StrictMode, type ReactNode } from 'react';
import { Provider, createStore } from 'jotai';
import { useSessionRuntime } from '@/hooks/useSessionRuntime';
import {
  sessionIdAtom,
  sessionNameAtom,
  attachInfoAtom,
  orderedUrlsAtom,
  forcedRelayAtom,
} from '@/atoms/session';
import { terminalSessionStateAtom, terminalTransportReadyAtom } from '@/terminal/state';
import type { AttachInfo } from '@/types';
import { SessionRuntime } from '@/runtime/SessionRuntime';
import { sessionRuntimeRegistry } from '@/runtime/SessionRuntimeRegistry';

const addressPlanState = vi.hoisted(() => ({
  urls: ['ws://shared-agent/ws'] as string[],
  ready: true,
}));

vi.mock('@/hooks/useAddressPlan', () => ({
  useAddressPlan: () => addressPlanState,
}));

const OriginalWebSocket = globalThis.WebSocket;
const WS = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

interface MockWs {
  _readyState: number;
  binaryType: string;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let instances: MockWs[] = [];

function setupMockWebSocket(): void {
  instances = [];
  function MockCtor(this: MockWs) {
    this._readyState = WS.CONNECTING;
    this.binaryType = 'arraybuffer';
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this.send = vi.fn();
    this.close = vi.fn(() => {
      this._readyState = WS.CLOSED;
      this.onclose?.(new CloseEvent('close'));
    });
    Object.defineProperty(this, 'readyState', {
      get: () => this._readyState,
      set: (v: number) => { this._readyState = v; },
      configurable: true,
    });
    instances.push(this);
  }
  (MockCtor as unknown as { CONNECTING: number }).CONNECTING = WS.CONNECTING;
  (MockCtor as unknown as { OPEN: number }).OPEN = WS.OPEN;
  globalThis.WebSocket = MockCtor as unknown as typeof WebSocket;
}

function lastWs(): MockWs {
  return instances[instances.length - 1];
}

function makeAttachInfo(sessionId: string, token: string): AttachInfo {
  return {
    mode: 'p2p',
    session_id: sessionId,
    agent_address: 'ws://shared-agent/ws',
    connection_token: token,
    addresses: [
      { url: 'ws://shared-agent/ws', label: 'A', network_type: 'lan', priority: 10, status: 'reachable' },
    ],
  };
}

function makeStore(sessionId: string, token: string) {
  const store = createStore();
  store.set(sessionIdAtom, sessionId);
  store.set(sessionNameAtom, sessionId.split(':')[1] ?? sessionId);
  store.set(attachInfoAtom, makeAttachInfo(sessionId, token));
  store.set(orderedUrlsAtom, ['ws://shared-agent/ws']);
  store.set(terminalSessionStateAtom, 'connecting');
  store.set(terminalTransportReadyAtom, true);
  return store;
}

function wrapper(store: ReturnType<typeof createStore>, strict = false) {
  const W = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { store }, strict ? createElement(StrictMode, null, children) : children);
  return W;
}

function releaseAllRuntimes(): void {
  for (const sid of ['agent:a', 'agent:b']) {
    sessionRuntimeRegistry.release(sid);
    sessionRuntimeRegistry.release(sid);
  }
}

describe('useSessionRuntime integration', () => {
  beforeEach(() => {
    addressPlanState.urls = ['ws://shared-agent/ws'];
    addressPlanState.ready = true;
    setupMockWebSocket();
  });

  afterEach(() => {
    releaseAllRuntimes();
    vi.clearAllMocks();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('exposes reactive p2pState when websocket connects (auto route)', async () => {
    const store = makeStore('agent:a', 'token-a');
    const { result } = renderHook(
      () => useSessionRuntime({ transportFirst: true }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => {
      expect(result.current.p2pConnection).not.toBeNull();
      expect(instances.length).toBeGreaterThan(0);
    });
    expect(result.current.p2pState).toBe('connecting');

    act(() => {
      const ws = lastWs();
      ws._readyState = WS.OPEN;
      ws.onopen?.(new Event('open'));
    });

    await waitFor(() => {
      expect(result.current.p2pState).toBe('connected');
    });
  });

  it('does not apply session B config to runtime A on session switch', async () => {
    const store = makeStore('agent:a', 'token-a');

    const { result, rerender } = renderHook(
      () => useSessionRuntime({ transportFirst: true }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => {
      expect(result.current.runtime?.sessionId).toBe('agent:a');
    });

    const runtimeA = result.current.runtime!;
    const aUpdateSpy = vi.spyOn(runtimeA, 'updateContext');

    act(() => {
      store.set(sessionIdAtom, 'agent:b');
      store.set(sessionNameAtom, 'b');
      store.set(attachInfoAtom, makeAttachInfo('agent:b', 'token-b'));
      store.set(orderedUrlsAtom, ['ws://shared-agent/ws']);
    });
    rerender();

    await waitFor(() => {
      expect(result.current.runtime?.sessionId).toBe('agent:b');
    });

    expect(aUpdateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        attachInfo: expect.objectContaining({ connection_token: 'token-b' }),
      }),
    );
    expect(result.current.runtime).not.toBe(runtimeA);
  });

  it('publishes fileOps after async address plan becomes ready', async () => {
    addressPlanState.urls = [];
    addressPlanState.ready = false;

    const store = makeStore('agent:a', 'token-a');
    const { result, rerender } = renderHook(
      () => useSessionRuntime({ transportFirst: true }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => {
      expect(result.current.runtime).not.toBeNull();
    });
    expect(result.current.fileOps).toBeNull();

    act(() => {
      addressPlanState.urls = ['ws://shared-agent/ws'];
      addressPlanState.ready = true;
    });
    rerender();

    await waitFor(() => {
      expect(result.current.p2pConnection).not.toBeNull();
    });
    await waitFor(() => {
      expect(result.current.fileOps).not.toBeNull();
    });
  });

  it('StrictMode replay keeps a single runtime for the same session', () => {
    const store = makeStore('agent:a', 'token-a');
    const seen: SessionRuntime[] = [];

    renderHook(
      () => {
        const rt = useSessionRuntime({ transportFirst: true });
        if (rt.runtime) {
          seen.push(rt.runtime);
        }
        return rt;
      },
      { wrapper: wrapper(store, true) },
    );

    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(1);
  });

  it('clears P2P state when forced to relay', async () => {
    const store = makeStore('agent:a', 'token-a');
    const { result, rerender } = renderHook(
      () => useSessionRuntime({ transportFirst: true }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => {
      expect(result.current.p2pConnection).not.toBeNull();
    });

    act(() => {
      store.set(forcedRelayAtom, true);
    });
    rerender();

    expect(result.current.p2pConnection).toBeNull();
    expect(result.current.p2pState).toBe('disconnected');
    expect(result.current.runtime).toBeNull();
  });
});
