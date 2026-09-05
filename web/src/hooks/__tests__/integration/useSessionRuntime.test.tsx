// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import { createElement, StrictMode, type ReactNode } from 'react';
import { Provider, createStore } from 'jotai';
import { useSessionRuntime } from '@/hooks/useSessionRuntime';
import {
  sessionIdAtom,
  sessionNameAtom,
  attachInfoAtom,
  orderedUrlsAtom,
  forcedRelayAtom,
  manualOverrideAtom,
} from '@/atoms/session';
import { routeIntentEpochAtom, isSwitchingAtom } from '@/atoms/connection';
import { terminalSessionStateAtom, terminalTransportReadyAtom } from '@/terminal/state';
import type { ConnectionState } from '@/services/socket/types';
import type { RelayServerHandle } from '@/runtime/relayServerConnection';
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

const SESSION_IDS = ['agent:a', 'agent:b', 'agent:failover-b', 'agent:failover-relay', 'agent:manual-fail', 'agent:relay'];

function expectRegistryEmpty(): void {
  for (const sid of SESSION_IDS) {
    expect(sessionRuntimeRegistry.get(sid)).toBeNull();
  }
}

describe('useSessionRuntime integration', () => {
  beforeEach(() => {
    addressPlanState.urls = ['ws://shared-agent/ws'];
    addressPlanState.ready = true;
    setupMockWebSocket();
  });

  afterEach(async () => {
    // Unmount mounted trees so every hook's effect cleanup releases its
    // registry lease, then wait out the deferred-dispose macrotask.
    cleanup();
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    });
    expectRegistryEmpty();
    vi.clearAllMocks();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('exposes reactive p2pState when websocket connects (auto route)', async () => {
    const store = makeStore('agent:a', 'token-a');
    const { result } = renderHook(
      () => useSessionRuntime({ transportFirst: true, configOwner: true }),
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
      () => useSessionRuntime({ transportFirst: true, configOwner: true }),
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
      () => useSessionRuntime({ transportFirst: true, configOwner: true }),
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
        const rt = useSessionRuntime({ transportFirst: true, configOwner: true });
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
      () => useSessionRuntime({ transportFirst: true, configOwner: true }),
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
    expect(result.current.runtime).not.toBeNull();
  });

  async function waitForRuntime(getRuntime: () => SessionRuntime | null): Promise<void> {
    await waitFor(() => {
      expect(getRuntime()).not.toBeNull();
    });
  }

  async function waitForRuntimeWs(getRuntime: () => SessionRuntime | null): Promise<void> {
    await waitForRuntime(getRuntime);
    await waitFor(() => {
      expect(instances.length).toBeGreaterThan(0);
    });
  }

  it('advances from A to B once with two shared-runtime consumers', async () => {
    addressPlanState.urls = ['ws://a/ws', 'ws://b/ws'];

    const store = makeStore('agent:a', 'token-a');
    store.set(orderedUrlsAtom, ['ws://a/ws', 'ws://b/ws']);
    store.set(attachInfoAtom, {
      ...makeAttachInfo('agent:a', 'token-a'),
      agent_address: 'ws://a/ws',
      addresses: [
        { url: 'ws://a/ws', label: 'A', network_type: 'lan', priority: 10, status: 'reachable' },
        { url: 'ws://b/ws', label: 'B', network_type: 'vpn', priority: 5, status: 'reachable' },
      ],
    });

    const shell = renderHook(() => useSessionRuntime({ transportFirst: true }), { wrapper: wrapper(store) });
    const terminal = renderHook(() => useSessionRuntime({ transportFirst: true, configOwner: true }), { wrapper: wrapper(store) });

    await waitForRuntimeWs(() => shell.result.current.runtime);
    const shared = shell.result.current.runtime!;
    expect(shared).toBe(terminal.result.current.runtime);

    const disconnectSpy = vi.spyOn(shared, 'onCandidateDisconnected');

    vi.useFakeTimers();
    await act(async () => {
      for (let i = 0; i <= 2; i += 1) {
        lastWs().onclose?.(new CloseEvent('close'));
        await vi.advanceTimersByTimeAsync(5_000);
      }
    });
    vi.useRealTimers();

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(shell.result.current.activeUrl).toBe('ws://b/ws');
    expect(store.get(forcedRelayAtom)).toBe(false);

    disconnectSpy.mockRestore();
    shell.unmount();
    terminal.unmount();
  });

  it('keeps B active after candidate rotation despite route epoch stability', async () => {
    addressPlanState.urls = ['ws://a/ws', 'ws://b/ws'];

    const store = makeStore('agent:failover-b', 'token-a');
    store.set(sessionIdAtom, 'agent:failover-b');
    store.set(orderedUrlsAtom, ['ws://a/ws', 'ws://b/ws']);
    store.set(attachInfoAtom, {
      ...makeAttachInfo('agent:failover-b', 'token-a'),
      agent_address: 'ws://a/ws',
      addresses: [
        { url: 'ws://a/ws', label: 'A', network_type: 'lan', priority: 10, status: 'reachable' },
        { url: 'ws://b/ws', label: 'B', network_type: 'vpn', priority: 5, status: 'reachable' },
      ],
    });

    const epochBefore = store.get(routeIntentEpochAtom);
    const { result, rerender } = renderHook(
      () => useSessionRuntime({ transportFirst: true, configOwner: true }),
      { wrapper: wrapper(store) },
    );

    await waitForRuntime(() => result.current.runtime);

    act(() => {
      expect(result.current.runtime!.onCandidateDisconnected()).toBe('next-candidate');
    });
    rerender();

    expect(result.current.activeUrl).toBe('ws://b/ws');
    expect(store.get(routeIntentEpochAtom)).toBe(epochBefore);
    rerender();
    expect(result.current.activeUrl).toBe('ws://b/ws');
  });

  it('mirrors force-relay from runtime event to forcedRelayAtom', async () => {
    addressPlanState.urls = ['ws://a/ws', 'ws://b/ws'];

    const store = makeStore('agent:failover-relay', 'token-a');
    store.set(sessionIdAtom, 'agent:failover-relay');
    store.set(orderedUrlsAtom, ['ws://a/ws', 'ws://b/ws']);
    store.set(attachInfoAtom, {
      ...makeAttachInfo('agent:failover-relay', 'token-a'),
      agent_address: 'ws://a/ws',
      addresses: [
        { url: 'ws://a/ws', label: 'A', network_type: 'lan', priority: 10, status: 'reachable' },
        { url: 'ws://b/ws', label: 'B', network_type: 'vpn', priority: 5, status: 'reachable' },
      ],
    });

    const { result, rerender } = renderHook(
      () => useSessionRuntime({ transportFirst: true, configOwner: true }),
      { wrapper: wrapper(store) },
    );

    await waitForRuntime(() => result.current.runtime);

    act(() => {
      expect(result.current.runtime!.onCandidateDisconnected()).toBe('next-candidate');
      expect(result.current.runtime!.onCandidateDisconnected()).toBe('force-relay');
    });
    rerender();

    expect(store.get(forcedRelayAtom)).toBe(true);
    rerender();
    expect(result.current.p2pConnection).toBeNull();
  });

  it('mirrors transport-exhausted to failed terminal state on manual route', async () => {
    addressPlanState.urls = ['ws://manual/ws'];

    const store = makeStore('agent:manual-fail', 'token-a');
    store.set(sessionIdAtom, 'agent:manual-fail');
    store.set(manualOverrideAtom, 'ws://manual/ws');
    store.set(attachInfoAtom, {
      ...makeAttachInfo('agent:manual-fail', 'token-a'),
      agent_address: 'ws://manual/ws',
      addresses: [
        { url: 'ws://manual/ws', label: 'Manual', network_type: 'lan', priority: 10, status: 'reachable' },
      ],
    });

    const { result, rerender } = renderHook(
      () => useSessionRuntime({ transportFirst: true, configOwner: true }),
      { wrapper: wrapper(store) },
    );

    await waitForRuntime(() => result.current.runtime);

    act(() => {
      expect(result.current.runtime!.onCandidateDisconnected()).toBe('transport-exhausted');
    });
    rerender();

    expect(store.get(terminalSessionStateAtom)).toBe('failed');
    expect(store.get(isSwitchingAtom)).toBe(false);
  });

  it('retains runtime in relay mode so attach can drive beginRelay', async () => {
    const store = makeStore('agent:relay', 'token-a');
    store.set(attachInfoAtom, { mode: 'relay', session_id: 'agent:relay' });

    const { result } = renderHook(
      () => useSessionRuntime({ transportFirst: true, configOwner: true }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => {
      expect(result.current.runtime).not.toBeNull();
    });
    await waitFor(() => {
      expect(result.current.p2pConnection).toBeNull();
    });
    expect(result.current.runtime!.sessionId).toBe('agent:relay');
  });

  it('legacy config owner does not overwrite connecting terminal state from runtime snapshot', async () => {
    const store = makeStore('agent:a', 'token-a');
    store.set(terminalSessionStateAtom, 'connecting');

    renderHook(
      () => useSessionRuntime({ transportFirst: false, configOwner: true }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => {
      expect(store.get(terminalSessionStateAtom)).toBe('connecting');
    });
  });


  it('relay fallback with an already-connected server ws attaches through the runtime without a React subscriber', async () => {
    const relayListeners = new Set<(state: ConnectionState) => void>();
    let currentState: ConnectionState = 'connected';
    const beginRelay = vi.fn();
    const serverConnection = {
      beginRelay,
      endRelay: vi.fn(),
      isReady: () => currentState === 'connected',
      emit(next: ConnectionState) {
        currentState = next;
        for (const cb of relayListeners) {
          cb(currentState);
        }
      },
      onConnectionStateChange: (cb: (state: ConnectionState) => void) => {
        relayListeners.add(cb);
        return () => relayListeners.delete(cb);
      },
    } satisfies RelayServerHandle & { emit(state: ConnectionState): void };

    const store = makeStore('agent:a', 'token-a');
    const { result } = renderHook(
      () => useSessionRuntime({ transportFirst: true, configOwner: true, serverConnection }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => {
      expect(result.current.runtime).not.toBeNull();
    });

    act(() => {
      result.current.runtime!.attachController.dispatch({ type: 'SESSION_SELECTED' });
    });
    act(() => {
      const ws = lastWs();
      ws._readyState = WS.OPEN;
      ws.onopen?.(new Event('open'));
    });
    await waitFor(() => {
      expect(result.current.p2pState).toBe('connected');
    });

    // Agent rejects the attach → auto-route fallback must flip to relay inside
    // the runtime and begin relay against the already-connected server ws.
    const attachCall = lastWs().send.mock.calls.find((call: unknown[]) => {
      const raw = String(call[0]);
      try {
        return JSON.parse(raw).msg_type === 'client.attach';
      } catch {
        return false;
      }
    })?.[0] as string | undefined;
    expect(attachCall).toBeTruthy();

    act(() => {
      const parsed = JSON.parse(attachCall as string) as { id: string };
      const ws = lastWs();
      ws.onmessage?.({ data: JSON.stringify({
        msg_type: 'error', id: parsed.id, timestamp: 0,
        payload: { message: 'agent rejected attach' },
      }) } as MessageEvent);
    });

    await waitFor(() => {
      expect(store.get(forcedRelayAtom)).toBe(true);
    });
    await waitFor(() => {
      expect(beginRelay).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(store.get(terminalSessionStateAtom)).toBe('attached');
    });
    expect(result.current.p2pConnection).toBeNull();
  });

  it('applies route-intent snapshot when config owner updates after subscribing', async () => {
    const store = makeStore('agent:a', 'token-a');
    store.set(terminalSessionStateAtom, 'attached');

    const { result, rerender } = renderHook(
      () => useSessionRuntime({ transportFirst: true, configOwner: true }),
      { wrapper: wrapper(store) },
    );

    await waitForRuntime(() => result.current.runtime);
    const rt = result.current.runtime!;
    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    rt.attachController.dispatch({ type: 'ATTACH_OK' });
    store.set(terminalSessionStateAtom, 'attached');

    act(() => {
      store.set(manualOverrideAtom, 'ws://shared-agent/ws');
      store.set(routeIntentEpochAtom, store.get(routeIntentEpochAtom) + 1);
    });
    rerender();

    await waitFor(() => {
      expect(store.get(terminalSessionStateAtom)).toBe('connecting');
    });
  });
});
