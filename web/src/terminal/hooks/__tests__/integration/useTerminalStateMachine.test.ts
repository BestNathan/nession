// web/src/terminal/hooks/__tests__/useTerminalStateMachine.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { Provider, createStore } from 'jotai';
import {
  useTerminalStateMachine,
  P2P_MAX_RECONNECT,
  ATTACH_TIMEOUT_MS,
} from '@/terminal/hooks/useTerminalStateMachine';
import { sessionIdAtom, sessionNameAtom, attachInfoAtom, forcedRelayAtom, manualOverrideAtom } from '@/atoms/session';
import { p2pConnectionAtom, routeIntentEpochAtom } from '@/atoms/connection';
import { terminalSessionStateAtom, lastResizeAtom, terminalTransportReadyAtom } from '@/terminal/state';
import type { P2PConnection, P2PMessage, P2PConnectionState as ConnectionState } from '@/services/socket/p2pTypes';
import type { WebSocketService } from '@/services/websocket';

// ── Test doubles ─────────────────────────────────────────────────────────────

/** Minimal mock of the server WebSocketService — only the members the state
 *  machine touches in relay mode. */
function makeServerConnection(isConnected: boolean, isAuthenticated = isConnected) {
  return {
    isConnected: () => isConnected,
    isAuthenticated: () => isAuthenticated,
    beginRelay: vi.fn(),
  } as unknown as WebSocketService;
}

/**
 * Mock P2PConnection whose `connectionState` is a getter backed by a mutable
 * closure variable — the same shape the real hook produces (stable object,
 * live getter). Tests drive the transport state via `setConnectionState`
 * without changing the connection object's identity.
 */
function makeP2PConnection() {
  let connState: ConnectionState = 'connected';
  const handlers: Array<(msg: P2PMessage) => void> = [];
  const sendMessage = vi.fn();
  const conn = {
    sendMessage,
    onMessage: vi.fn((handler: (msg: P2PMessage) => void) => {
      handlers.push(handler);
      return vi.fn();
    }),
    close: vi.fn(),
    waitForConnection: vi.fn(),
    reconnectAttempt: 0,
    get connectionState() {
      return connState;
    },
  } as unknown as P2PConnection;

  return {
    conn,
    sendMessage,
    getHandlers: () => handlers,
    setConnectionState: (s: ConnectionState) => { connState = s; },
  };
}

/** Create a fresh jotai store pre-seeded with the session/terminal atoms. */
function makeStore(opts: {
  mode: 'p2p' | 'relay';
  sessionId?: string;
  sessionName?: string;
  resize?: { cols: number; rows: number };
}) {
  const store = createStore();
  store.set(sessionIdAtom, opts.sessionId ?? 'agent:sess');
  store.set(sessionNameAtom, opts.sessionName ?? 'sess');
  if (opts.mode === 'relay') {
    store.set(forcedRelayAtom, true);
  } else {
    store.set(attachInfoAtom, { mode: 'p2p', session_id: opts.sessionId ?? 'agent:sess' });
  }
  if (opts.resize) { store.set(lastResizeAtom, opts.resize); }
  // The real attach flow sets the state machine to 'connecting' before the
  // terminal mounts; match that entry condition.
  store.set(terminalSessionStateAtom, 'connecting');
  store.set(terminalTransportReadyAtom, true);
  return store;
}

/** renderHook wrapped in a jotai Provider bound to `store`. */
function renderWithStore(store: ReturnType<typeof makeStore>, ui: () => ReturnType<typeof useTerminalStateMachine>) {
  return renderHook(ui, {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store }, children),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useTerminalStateMachine', () => {
  beforeEach(() => {
    // Silence the [Bridge] transition log; it fires on every reconnect promote.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('relay: connecting → connected → attached, carrying the lastResize size', () => {
    const serverConnection = makeServerConnection(true);
    const store = makeStore({
      mode: 'relay',
      sessionId: 'agent:sess',
      resize: { cols: 120, rows: 40 },
    });

    const { result } = renderWithStore(store, () =>
      useTerminalStateMachine({ serverConnection }),
    );

    // server ws authenticated → connecting promotes to connected immediately, and
    // the connected case fire-and-forgets beginRelay then attaches.
    expect(result.current.terminalState).toBe('attached');
    expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
    expect(serverConnection.beginRelay).toHaveBeenCalledWith('agent:sess', undefined, 120, 40);
  });

  it('relay: stays in connecting while the server ws is not yet connected', () => {
    const serverConnection = makeServerConnection(false);
    const store = makeStore({ mode: 'relay', sessionId: 'agent:sess' });

    const { result } = renderWithStore(store, () =>
      useTerminalStateMachine({ serverConnection }),
    );

    expect(result.current.terminalState).toBe('connecting');
    expect(serverConnection.beginRelay).not.toHaveBeenCalled();
  });

  it('relay: stays connecting while the ws is open but not yet authenticated', () => {
    const serverConnection = makeServerConnection(true, false);
    const store = makeStore({ mode: 'relay', sessionId: 'agent:sess' });

    const { result } = renderWithStore(store, () =>
      useTerminalStateMachine({ serverConnection }),
    );

    // isConnected() true, isAuthenticated() false — beginRelay would be dropped
    // by the server pre-auth, so the machine must not promote to connected.
    expect(result.current.terminalState).toBe('connecting');
    expect(serverConnection.beginRelay).not.toHaveBeenCalled();
  });

  it('p2p: connecting → connected (bridge) → client.attach → attached; resize read via ref', () => {
    const { conn, sendMessage, getHandlers } = makeP2PConnection();
    const store = makeStore({
      mode: 'p2p',
      sessionId: 'agent:sess',
      sessionName: 'sess',
      resize: { cols: 100, rows: 30 },
    });
    store.set(p2pConnectionAtom, conn);

    const { result } = renderWithStore(store, () => useTerminalStateMachine());

    // The transport is already up, so the bridge promotes connecting → connected.
    expect(result.current.terminalState).toBe('connected');

    // client.attach carries session_name + the lastResize width/height.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        msg_type: 'client.attach',
        payload: expect.objectContaining({
          session_name: 'sess',
          width: 100,
          height: 30,
        }),
      }),
    );

    // lastResizeAtom changed AFTER the effect ran: it must be reflected via the
    // ref on the next attach, but must NOT re-trigger the state machine.
    act(() => { store.set(lastResizeAtom, { cols: 200, rows: 50 }); });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(result.current.terminalState).toBe('connected');

    // Reconnect cycle: transport drops → reconnecting → (still-up socket) the
    // bridge bounces straight back to connected → a fresh client.attach is sent,
    // now reading the latest resize through lastResizeRef.
    act(() => { store.set(terminalSessionStateAtom, 'reconnecting'); });
    expect(result.current.terminalState).toBe('connected');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        msg_type: 'client.attach',
        payload: expect.objectContaining({ width: 200, height: 50 }),
      }),
    );
    const reattach = sendMessage.mock.calls[1][0] as { id: string };

    // Agent acks the (re)attach → attached.
    act(() => {
      const handlers = getHandlers();
      handlers[handlers.length - 1]({
        id: reattach.id,
        msg_type: 'ok',
        timestamp: Math.floor(Date.now() / 1000),
        payload: {},
      });
    });
    expect(result.current.terminalState).toBe('attached');
  });

  it('p2p: attach timeout backs off into reconnecting', () => {
    vi.useFakeTimers();
    const { conn, sendMessage, setConnectionState } = makeP2PConnection();
    const store = makeStore({ mode: 'p2p', sessionId: 'agent:sess', sessionName: 'sess' });
    store.set(p2pConnectionAtom, conn);

    const { result } = renderWithStore(store, () => useTerminalStateMachine());
    expect(result.current.terminalState).toBe('connected');
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // The agent never acks. The transport is flaky too (that's why the attach
    // is unanswered), so p2pState reads reconnecting when the timeout fires —
    // otherwise the bridge would bounce reconnecting → connected immediately and
    // the state machine would never visibly land in reconnecting.
    setConnectionState('reconnecting');
    act(() => { vi.advanceTimersByTime(ATTACH_TIMEOUT_MS); });

    expect(result.current.terminalState).toBe('reconnecting');
    expect(result.current.reconnectCount).toBe(1);
  });

  it('p2p: exhausting the reconnect budget forces relay fallback in auto mode', () => {
    const { conn, setConnectionState } = makeP2PConnection();
    const store = makeStore({ mode: 'p2p', sessionId: 'agent:sess', sessionName: 'sess' });
    store.set(p2pConnectionAtom, conn);

    const { result, rerender } = renderWithStore(store, () => useTerminalStateMachine());
    expect(result.current.terminalState).toBe('connected');

    for (let i = 1; i <= P2P_MAX_RECONNECT + 1; i++) {
      act(() => { setConnectionState('reconnecting'); rerender(); });
      if (i <= P2P_MAX_RECONNECT) {
        act(() => { setConnectionState('connected'); rerender(); });
      }
    }

    expect(store.get(forcedRelayAtom)).toBe(true);
    expect(result.current.terminalState).toBe('connecting');
    // The route epoch is a user-route identity, not a fallback signal —
    // falling back to relay must not bump it.
    expect(store.get(routeIntentEpochAtom)).toBe(0);
  });

  it('p2p: exhausting the reconnect budget lands on failed with manual override', () => {
    const { conn, setConnectionState } = makeP2PConnection();
    const store = makeStore({ mode: 'p2p', sessionId: 'agent:sess', sessionName: 'sess' });
    store.set(p2pConnectionAtom, conn);
    store.set(manualOverrideAtom, 'ws://manual/ws');

    const { result, rerender } = renderWithStore(store, () => useTerminalStateMachine());
    expect(result.current.terminalState).toBe('connected');

    for (let i = 1; i <= P2P_MAX_RECONNECT + 1; i++) {
      act(() => { setConnectionState('reconnecting'); rerender(); });
      if (i <= P2P_MAX_RECONNECT) {
        act(() => { setConnectionState('connected'); rerender(); });
      }
    }

    expect(store.get(forcedRelayAtom)).toBe(false);
    expect(result.current.terminalState).toBe('failed');
  });

  it('p2p: attach error in auto mode falls back to relay without bumping routeIntentEpochAtom', () => {
    const { conn, getHandlers } = makeP2PConnection();
    const serverConnection = makeServerConnection(true);
    const store = makeStore({ mode: 'p2p', sessionId: 'agent:sess', sessionName: 'sess' });
    store.set(p2pConnectionAtom, conn);

    const { result } = renderWithStore(store, () =>
      useTerminalStateMachine({ serverConnection }),
    );
    expect(result.current.terminalState).toBe('connected');

    const attachCall = (conn.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string };
    act(() => {
      for (const h of getHandlers()) {
        h({ msg_type: 'error', id: attachCall.id, timestamp: 0, payload: { message: 'agent busy' } });
      }
    });

    expect(store.get(forcedRelayAtom)).toBe(true);
    expect(store.get(routeIntentEpochAtom)).toBe(0);
    // Relay attach completes against the authenticated server connection.
    expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
    expect(result.current.terminalState).toBe('attached');
  });

  it('relay: reconnecting after P2P transport fallback begins relay attach', () => {
    const serverConnection = makeServerConnection(true);
    const store = makeStore({ mode: 'p2p', sessionId: 'agent:sess', sessionName: 'sess' });
    store.set(terminalSessionStateAtom, 'reconnecting');
    store.set(forcedRelayAtom, true);

    const { result } = renderWithStore(store, () =>
      useTerminalStateMachine({ serverConnection }),
    );

    expect(result.current.terminalState).toBe('attached');
    expect(serverConnection.beginRelay).toHaveBeenCalledTimes(1);
  });

  it('p2p: uses explicit p2pState prop for bridge transition', () => {
    const { conn, sendMessage } = makeP2PConnection();
    const store = makeStore({ mode: 'p2p', sessionId: 'agent:sess', sessionName: 'sess' });

    const { result, rerender } = renderHook(
      ({ p2pState }: { p2pState: ConnectionState }) =>
        useTerminalStateMachine({ p2pConnection: conn, p2pState }),
      {
        initialProps: { p2pState: 'connecting' as ConnectionState },
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(Provider, { store }, children),
      },
    );

    expect(result.current.terminalState).toBe('connecting');
    expect(sendMessage).not.toHaveBeenCalled();

    rerender({ p2pState: 'connected' });

    expect(result.current.terminalState).toBe('connected');
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ msg_type: 'client.attach' }),
    );
  });
});
