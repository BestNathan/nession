import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionRuntime } from '@/runtime/SessionRuntime';
import { ATTACH_TIMEOUT_MS, P2P_MAX_RECONNECT } from '@/runtime/AttachStateMachine';
import type { RelayServerHandle } from '@/runtime/relayServerConnection';
import type { ConnectionState } from '@/services/socket/types';
import type { AttachInfo } from '@/types';

const OriginalWebSocket = globalThis.WebSocket;

interface MockWs {
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  send: ReturnType<typeof vi.fn>;
}

let wsInstances: MockWs[] = [];

function lastWs(): MockWs {
  return wsInstances[wsInstances.length - 1];
}

/** Drive a mock ws to the open state (AgentSocketClient.setState('connected')). */
function openWs(): void {
  const ws = lastWs();
  ws.readyState = 1;
  ws.onopen?.(new Event('open'));
}

/** Count client.attach messages sent on any tracked ws. */
function countClientAttach(): number {
  let count = 0;
  for (const ws of wsInstances) {
    for (const call of ws.send.mock.calls) {
      try {
        const parsed = JSON.parse(String(call[0]));
        if (parsed.msg_type === 'client.attach') {
          count += 1;
        }
      } catch {
        // non-JSON (binary) frame — ignore
      }
    }
  }
  return count;
}


/** Flush one or two microtask hops (requestRelayAttach defers relay attach). */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

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

function makeRelayServerConnection(initialState: ConnectionState = 'disconnected') {
  const listeners = new Set<(state: ConnectionState) => void>();
  let current: ConnectionState = initialState;
  const beginRelay = vi.fn();
  return {
    beginRelay,
    endRelay: vi.fn(),
    isReady: () => current === 'connected',
    emit(next: ConnectionState) {
      current = next;
      for (const cb of listeners) {
        cb(current);
      }
    },
    onConnectionStateChange(cb: (state: ConnectionState) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } satisfies RelayServerHandle & { emit(state: ConnectionState): void };
}

describe('SessionRuntime', () => {
  beforeEach(() => {
    wsInstances = [];
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
        wsInstances.push(this);
      }
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

  it('publishes a cached session snapshot for React external stores', () => {
    const rt = new SessionRuntime(makeConfig());
    const changes = vi.fn();
    const unsubscribe = rt.subscribe(changes);

    expect(rt.getSnapshot().activeUrl).toBe('ws://a/ws');
    rt.setTransportReady(true);
    rt.updateViewportSize({ cols: 120, rows: 40 });

    expect(changes).toHaveBeenCalledTimes(2);
    expect(rt.getSnapshot()).toMatchObject({
      transportReady: true,
      lastResize: { cols: 120, rows: 40 },
    });
    unsubscribe();
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




  describe('relay reconnect across intra-budget server-ws loss', () => {
    it('re-begins exactly once across connected -> connecting -> connected (recoverable loss cycle)', async () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({ forcedRelay: true, transportReady: true, serverConnection }));

      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await flushMicrotasks();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
      expect(rt.attachState.phase).toBe('attached');

      // Recoverable loss: state leaves 'connected' for 'connecting' (intra-budget
      // drop — the new transport surfaces it distinctly from 'disconnected').
      serverConnection.emit('connecting');
      expect(rt.attachState.phase).toBe('reconnecting');
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);

      // Post-handshake 'connected' (old 'authenticated') handoff re-drives relay.
      serverConnection.emit('connected');
      await flushMicrotasks();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(2);
      expect(rt.attachState.phase).toBe('attached');

      // A full second loss cycle re-begins once more.
      serverConnection.emit('connecting');
      serverConnection.emit('connected');
      await flushMicrotasks();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(3);
      expect(rt.attachState.phase).toBe('attached');
      rt.dispose();
    });

    it('ignores repeated connecting while already reconnecting (no double TRANSPORT_LOST)', async () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({ forcedRelay: true, transportReady: true, serverConnection }));

      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await flushMicrotasks();
      expect(rt.attachState.phase).toBe('attached');

      const events: string[] = [];
      rt.subscribeRuntimeEvents((e) => events.push(e.type));
      serverConnection.emit('connecting');
      serverConnection.emit('connecting');
      expect(rt.attachState.phase).toBe('reconnecting');
      expect(events.filter((t) => t === 'route-intent-changed')).toHaveLength(1);

      serverConnection.emit('connected');
      await flushMicrotasks();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(2);
      rt.dispose();
    });
  });

  describe('atomic P2P -> relay fallback (runtime-owned beginRelay)', () => {
    it('attach-error fallback begins relay immediately when the server ws is already connected', async () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({ transportReady: true, serverConnection }));

      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      await flushMicrotasks();
      // P2P transport active — no relay attach yet.
      expect(serverConnection.beginRelay).not.toHaveBeenCalled();
      expect(rt.attachState.phase).toBe('connecting');

      rt.attachController.dispatch({ type: 'ATTACH_ERROR', manualRoute: false });
      await flushMicrotasks();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
      expect(rt.attachState.phase).toBe('attached');
      expect(rt.activeUrl).toBeNull();
      expect(rt.getP2PConnection()).toBeNull();
      rt.dispose();
    });

    it('defers beginRelay while the server ws is not ready, then begins exactly once on connected', async () => {
      const serverConnection = makeRelayServerConnection('connecting');
      const rt = new SessionRuntime(makeConfig({ transportReady: true, serverConnection }));

      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      rt.attachController.dispatch({ type: 'ATTACH_ERROR', manualRoute: false });
      await flushMicrotasks();
      expect(serverConnection.beginRelay).not.toHaveBeenCalled();
      expect(rt.attachState.phase).toBe('connecting');

      serverConnection.emit('connected');
      await flushMicrotasks();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
      expect(rt.attachState.phase).toBe('attached');

      // A second connected (no loss in between) must not re-begin.
      serverConnection.emit('connected');
      await flushMicrotasks();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
      rt.dispose();
    });

    it('candidate/address exhaustion routes through applyForceRelay (single force-relay event, p2p torn down)', async () => {
      const serverConnection = makeRelayServerConnection('connected');
      const rt = new SessionRuntime(makeConfig({ transportReady: true, serverConnection }));
      const events: string[] = [];
      rt.subscribeRuntimeEvents((e) => events.push(e.type));

      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      expect(rt.onCandidateDisconnected()).toBe('next-candidate');
      expect(rt.onCandidateDisconnected()).toBe('force-relay');
      await flushMicrotasks();

      expect(events.filter((t) => t === 'force-relay')).toHaveLength(1);
      expect(rt.activeUrl).toBeNull();
      expect(rt.getP2PConnection()).toBeNull();
      expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
      expect(rt.attachState.phase).toBe('attached');
      rt.dispose();
    });
  });


  describe('session capability registry', () => {
    it('registers the file capability when the client is created and unregisters on teardown', () => {
      const rt = new SessionRuntime(makeConfig());
      expect(rt.getSessionCapability('files')).toBe(rt.getFileCapability());
      expect(rt.getSessionCapability('files')).not.toBeNull();

      rt.updateContext({ forcedRelay: true });
      expect(rt.getSessionCapability('files')).toBeNull();
      expect(rt.getFileCapability()).toBeNull();
      rt.dispose();
    });

    it('disposes a replaced capability instance and on unregister', () => {
      const rt = new SessionRuntime(makeConfig());
      const disposeA = vi.fn();
      const disposeB = vi.fn();
      rt.registerSessionCapability('probe', { kind: 'a' }, disposeA);
      rt.registerSessionCapability('probe', { kind: 'b' }, disposeB);
      expect(disposeA).toHaveBeenCalledOnce();
      expect(rt.getSessionCapability<{ kind: string }>('probe')?.kind).toBe('b');

      rt.unregisterSessionCapability('probe');
      expect(disposeB).toHaveBeenCalledOnce();
      expect(rt.getSessionCapability('probe')).toBeNull();
      rt.dispose();
    });

    it('survives unrelated config updates', () => {
      const rt = new SessionRuntime(makeConfig());
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      rt.updateContext({ lastResize: { cols: 100, rows: 40 } });
      expect(rt.getSessionCapability('files')).toBe(rt.getFileCapability());
      rt.dispose();
    });
  });

  describe('self-driving attach retry', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('re-sends client.attach automatically after each attach timeout until the budget is exhausted (auto route)', () => {
      vi.useFakeTimers();
      const rt = new SessionRuntime(makeConfig({ transportReady: true }));
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      openWs();
      expect(rt.attachState.phase).toBe('connecting');
      expect(countClientAttach()).toBe(1);

      // No React/manual re-invocation — each timeout must schedule the next attach itself.
      for (let i = 0; i < P2P_MAX_RECONNECT; i += 1) {
        vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
        expect(countClientAttach()).toBe(i + 2);
      }
      // Budget exhausted on the auto route: force-relay, P2P client torn down, no further attach.
      vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
      expect(countClientAttach()).toBe(P2P_MAX_RECONNECT + 1);
      expect(rt.attachState.phase).toBe('connecting');
      expect(rt.getP2PConnection()).toBeNull();
      vi.advanceTimersByTime(ATTACH_TIMEOUT_MS * 2);
      expect(countClientAttach()).toBe(P2P_MAX_RECONNECT + 1);
      rt.dispose();
    });

    it('stops retrying with failed on a manual route after the budget is exhausted', () => {
      vi.useFakeTimers();
      const rt = new SessionRuntime(makeConfig({ transportReady: true, manualOverride: 'ws://a/ws' }));
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      openWs();
      expect(countClientAttach()).toBe(1);

      for (let i = 0; i < P2P_MAX_RECONNECT; i += 1) {
        vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
      }
      expect(countClientAttach()).toBe(P2P_MAX_RECONNECT + 1);
      vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
      expect(rt.attachState.phase).toBe('failed');
      vi.advanceTimersByTime(ATTACH_TIMEOUT_MS * 2);
      expect(countClientAttach()).toBe(P2P_MAX_RECONNECT + 1);
      rt.dispose();
    });

    it('updateContext churn during an in-flight attach neither cancels nor duplicates the attempt', () => {
      vi.useFakeTimers();
      const rt = new SessionRuntime(makeConfig({ transportReady: true }));
      rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
      openWs();
      expect(countClientAttach()).toBe(1);

      rt.updateContext({ lastResize: { cols: 120, rows: 40 } });
      rt.updateContext({ lastResize: { cols: 80, rows: 24 } });
      expect(countClientAttach()).toBe(1);

      vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
      expect(countClientAttach()).toBe(2);
      expect(rt.attachState.reconnectCount).toBe(1);
      rt.dispose();
    });
  });

  it('re-begins relay after server websocket reconnect', async () => {
    const serverConnection = makeRelayServerConnection('connected');
    const rt = new SessionRuntime(makeConfig({
      forcedRelay: true,
      transportReady: true,
      serverConnection,
    }));

    // Relay attach is runtime-driven: SESSION_SELECTED → connecting, and the
    // already-connected server WS begins relay without any React driver.
    rt.attachController.dispatch({ type: 'SESSION_SELECTED' });
    await flushMicrotasks();
    expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
    expect(rt.attachState.phase).toBe('attached');

    serverConnection.emit('disconnected');
    expect(rt.attachState.phase).toBe('reconnecting');
    expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);

    serverConnection.emit('connected');
    await flushMicrotasks();
    expect(serverConnection.beginRelay).toHaveBeenCalledTimes(2);
    expect(rt.attachState.phase).toBe('attached');
    rt.dispose();
  });
});
