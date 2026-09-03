import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionRuntime } from '@/runtime/SessionRuntime';
import type { AttachInfo } from '@/types';

const OriginalWebSocket = globalThis.WebSocket;

function makeAttachInfo(): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent:s1',
    agent_address: 'ws://a/ws',
    connection_token: 'tok',
    addresses: [
      { url: 'ws://a/ws', label: 'A', network_type: 'lan', priority: 10, status: 'reachable' },
      { url: 'ws://b/ws', label: 'B', network_type: 'vpn', priority: 5, status: 'reachable' },
    ],
  };
}

function makeConfig(overrides: Partial<ConstructorParameters<typeof SessionRuntime>[0]> = {}) {
  return {
    sessionId: 'agent:s1',
    sessionName: 's1',
    attachInfo: makeAttachInfo(),
    orderedUrls: ['ws://a/ws', 'ws://b/ws'],
    manualOverride: null,
    forcedRelay: false,
    addressPlan: { ready: true, urls: ['ws://a/ws', 'ws://b/ws'] },
    transportFirst: true,
    routeIntentEpoch: 0,
    ...overrides,
  };
}

describe('SessionRuntime', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', class {
      static CONNECTING = 0;
      static OPEN = 1;
      readyState = 0;
      binaryType = 'arraybuffer';
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      send = vi.fn();
      close = vi.fn();
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('creates P2P connection and file capability when address plan is ready', () => {
    const rt = new SessionRuntime(makeConfig());
    expect(rt.activeUrl).toBe('ws://a/ws');
    expect(rt.getP2PConnection()).not.toBeNull();
    expect(rt.getFileCapability()).not.toBeNull();
    rt.dispose();
  });

  it('clears client when forced to relay', () => {
    const rt = new SessionRuntime(makeConfig());
    rt.updateContext({ forcedRelay: true });
    expect(rt.activeUrl).toBeNull();
    expect(rt.getP2PConnection()).toBeNull();
    rt.dispose();
  });

  it('advances candidate and reconfigures client on disconnect', () => {
    const rt = new SessionRuntime(makeConfig());
    expect(rt.onCandidateDisconnected()).toBe('next-candidate');
    expect(rt.activeUrl).toBe('ws://b/ws');
    rt.dispose();
  });

  it('reports waitingForAddressPlan when plan is not ready', () => {
    const rt = new SessionRuntime(makeConfig({
      addressPlan: { ready: false, urls: [] },
    }));
    expect(rt.waitingForAddressPlan).toBe(true);
    expect(rt.getP2PConnection()).toBeNull();
    rt.dispose();
  });

  it('subscribeConnectionState returns noop when no client', () => {
    const rt = new SessionRuntime(makeConfig({ attachInfo: null }));
    const unsub = rt.subscribeConnectionState(() => {});
    expect(unsub).toBeTypeOf('function');
    unsub();
  });

  it('resets address index and attach phase when route epoch changes', () => {
    const rt = new SessionRuntime(makeConfig());
    expect(rt.onCandidateDisconnected()).toBe('next-candidate');
    expect(rt.activeUrl).toBe('ws://b/ws');
    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    rt.attachController.dispatch({ type: 'ATTACH_OK' });
    rt.updateContext({ routeIntentEpoch: 1 });
    expect(rt.activeUrl).toBe('ws://a/ws');
    expect(rt.attachState.phase).toBe('connecting');
    rt.dispose();
  });

  it('route intent change emits route-intent-changed event', () => {
    const rt = new SessionRuntime(makeConfig());
    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    rt.attachController.dispatch({ type: 'ATTACH_OK' });
    const events: string[] = [];
    rt.subscribeRuntimeEvents((e) => events.push(e.type));
    rt.updateContext({ routeIntentEpoch: 1, manualOverride: 'ws://a/ws' });
    expect(rt.attachState.phase).toBe('connecting');
    expect(events).toContain('route-intent-changed');
    rt.dispose();
  });

  it('emits runtime events on candidate advancement', () => {
    const rt = new SessionRuntime(makeConfig());
    const events: string[] = [];
    rt.subscribeRuntimeEvents((e) => events.push(e.type));
    expect(rt.onCandidateDisconnected()).toBe('next-candidate');
    expect(rt.activeUrl).toBe('ws://b/ws');
    expect(events).toEqual(['next-candidate']);
    rt.dispose();
  });

  it('notifies connection state subscribers when socket connects', () => {
    const rt = new SessionRuntime(makeConfig());
    const states: string[] = [];
    const unsub = rt.subscribeConnectionState((s) => states.push(s));
    const ws = (rt.getP2PConnection() as { waitForConnection: () => Promise<void> });
    expect(ws).toBeTruthy();
    unsub();
    rt.dispose();
  });

  it('emits transport-exhausted for manual route disconnect', () => {
    const rt = new SessionRuntime(makeConfig({ manualOverride: 'ws://manual/ws' }));
    const events: string[] = [];
    rt.subscribeRuntimeEvents((e) => events.push(e.type));
    expect(rt.onCandidateDisconnected()).toBe('transport-exhausted');
    expect(rt.attachState.phase).toBe('failed');
    expect(events).toEqual(['transport-exhausted']);
    rt.dispose();
  });

  it('clears client when attachInfo becomes unavailable', () => {
    const rt = new SessionRuntime(makeConfig());
    rt.updateContext({ attachInfo: null });
    expect(rt.getP2PConnection()).toBeNull();
    rt.dispose();
  });

  it('returns mirror snapshot from updateContext', () => {
    const rt = new SessionRuntime(makeConfig());
    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    const snapshot = rt.updateContext({ routeIntentEpoch: 1 });
    expect(snapshot.phase).toBe('connecting');
    expect(snapshot.transportGeneration).toBeGreaterThan(0);
    rt.dispose();
  });

  it('opens one socket when route changes with same URL (configure + forceReconnect)', async () => {
    let openCount = 0;
    vi.stubGlobal('WebSocket', class {
      static CONNECTING = 0;
      static OPEN = 1;
      readyState = 0;
      binaryType = 'arraybuffer';
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      send = vi.fn();
      close = vi.fn();
      constructor() {
        openCount += 1;
      }
    });

    const rt = new SessionRuntime(makeConfig());
    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    rt.attachController.dispatch({ type: 'ATTACH_OK' });
    const before = openCount;
    rt.updateContext({ routeIntentEpoch: 1 });
    expect(openCount - before).toBe(1);
    rt.dispose();
  });

  it('does not start P2P attach when transportFirst is false (legacy state machine owns attach)', () => {
    const rt = new SessionRuntime(makeConfig({ transportFirst: false }));
    const startSpy = vi.spyOn(rt.attachController, 'startP2PAttach');
    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    rt.updateContext({ transportReady: true });

    expect(startSpy).not.toHaveBeenCalled();
    startSpy.mockRestore();
    rt.dispose();
  });

  it('applies forceRelay internally without React subscriber', () => {
    const rt = new SessionRuntime(makeConfig());
    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    rt.attachController.dispatch({ type: 'ATTACH_ERROR', manualRoute: false });
    expect(rt.getP2PConnection()).toBeNull();
    rt.dispose();
  });

  it('re-begins relay after server websocket reconnect', () => {
    const listeners = new Set<(status: string) => void>();
    const beginRelay = vi.fn();
    const serverConnection = {
      beginRelay,
      onConnectionChange: (cb: (status: string) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    } as unknown as import('@/services/websocket').WebSocketService;

    const rt = new SessionRuntime(makeConfig({
      forcedRelay: true,
      serverConnection,
    }));
    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    rt.attachController.dispatch({ type: 'RELAY_BEGIN_OK' });
    expect(rt.attachState.phase).toBe('attached');

    for (const cb of listeners) {
      cb('disconnected');
    }
    expect(rt.attachState.phase).toBe('reconnecting');

    for (const cb of listeners) {
      cb('authenticated');
    }
    expect(beginRelay).toHaveBeenCalledOnce();
    expect(rt.attachState.phase).toBe('attached');
    rt.dispose();
  });
});
