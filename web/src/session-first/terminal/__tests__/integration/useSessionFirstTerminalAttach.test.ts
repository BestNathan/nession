import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { Provider, createStore } from 'jotai';
import {
  useSessionFirstTerminalAttach,
  P2P_MAX_RECONNECT,
  ATTACH_TIMEOUT_MS,
} from '@/session-first/terminal/useSessionFirstTerminalAttach';
import {
  sessionIdAtom,
  sessionNameAtom,
  attachInfoAtom,
  forcedRelayAtom,
  manualOverrideAtom,
} from '@/atoms/session';
import { terminalSessionStateAtom, lastResizeAtom, terminalTransportReadyAtom } from '@/terminal/state';
import type { P2PConnection, P2PMessage, ConnectionState } from '@/hooks/useP2PConnection';
import type { WebSocketService } from '@/services/websocket';
import { AttachStateMachine } from '@/runtime/AttachStateMachine';
import { SessionAttachController } from '@/runtime/SessionAttachController';
import type { SessionRuntime } from '@/runtime/SessionRuntime';

function makeServerConnection(isConnected: boolean) {
  return {
    isConnected: () => isConnected,
    beginRelay: vi.fn(),
    onConnectionChange: vi.fn(() => () => {}),
  } as unknown as WebSocketService;
}

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

function makeStore(opts: {
  mode: 'p2p' | 'relay';
  sessionId?: string;
  sessionName?: string;
  resize?: { cols: number; rows: number };
  transportReady?: boolean;
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
  store.set(terminalSessionStateAtom, 'connecting');
  store.set(terminalTransportReadyAtom, opts.transportReady ?? true);
  return store;
}

function makeRuntime(): SessionRuntime {
  const attachState = new AttachStateMachine({ transportFirst: true });
  return {
    attachState,
    attachController: new SessionAttachController(attachState),
  } as SessionRuntime;
}

function renderAttachHook(opts: {
  store: ReturnType<typeof makeStore>;
  p2p: ReturnType<typeof makeP2PConnection> | null;
  wsService: WebSocketService;
  p2pState?: ConnectionState;
  runtime?: SessionRuntime | null;
}) {
  const { store, p2p, wsService } = opts;
  const runtime = opts.runtime ?? makeRuntime();
  const initialState = opts.p2pState ?? (p2p ? p2p.conn.connectionState : 'disconnected');
  return renderHook(
    ({ state }: { state?: ConnectionState } = { state: initialState }) =>
      useSessionFirstTerminalAttach({
        sessionId: store.get(sessionIdAtom),
        sessionName: store.get(sessionNameAtom),
        p2pConnection: p2p?.conn ?? null,
        p2pState: state ?? initialState,
        wsService,
        runtime,
      }),
    {
      initialProps: { state: initialState },
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(Provider, { store }, children),
    },
  );
}

describe('useSessionFirstTerminalAttach', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('P2P: does not send client.attach before transport is ready', () => {
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p', transportReady: false });

    renderAttachHook({ store, p2p, wsService });

    expect(p2p.sendMessage).not.toHaveBeenCalled();
    expect(store.get(terminalSessionStateAtom)).toBe('connecting');
  });

  it('P2P: sends client.attach only after transport ready and socket connected', () => {
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p', transportReady: false });

    const { rerender } = renderAttachHook({ store, p2p, wsService });
    expect(p2p.sendMessage).not.toHaveBeenCalled();

    act(() => {
      store.set(terminalTransportReadyAtom, true);
    });
    rerender({ state: 'connected' });

    expect(p2p.sendMessage).toHaveBeenCalledTimes(1);
    expect(p2p.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ msg_type: 'client.attach' }),
    );
  });

  it('P2P: sends client.attach when reactive p2pState transitions connecting → connected', () => {
    const p2p = makeP2PConnection();
    p2p.setConnectionState('connecting');
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p', transportReady: true });

    const { rerender } = renderAttachHook({ store, p2p, wsService, p2pState: 'connecting' });
    expect(p2p.sendMessage).not.toHaveBeenCalled();

    rerender({ state: 'connected' });

    expect(p2p.sendMessage).toHaveBeenCalledTimes(1);
    expect(p2p.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ msg_type: 'client.attach' }),
    );
  });

  it('P2P: attach ok transitions to attached', () => {
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p', resize: { cols: 80, rows: 24 } });

    const { result } = renderAttachHook({ store, p2p, wsService });

    const attachCall = p2p.sendMessage.mock.calls[0][0] as { id: string };
    act(() => {
      for (const h of p2p.getHandlers()) {
        h({ msg_type: 'ok', id: attachCall.id, timestamp: 0, payload: {} });
      }
    });

    expect(result.current.terminalState).toBe('attached');
  });

  it('P2P: attach timeout backs off into reconnecting', () => {
    vi.useFakeTimers();
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p' });

    const { result } = renderAttachHook({ store, p2p, wsService });

    act(() => {
      vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
    });

    expect(result.current.terminalState).toBe('reconnecting');
    expect(result.current.reconnectCount).toBe(1);
  });

  it('relay: beginRelay waits for transport ready and ws connected', () => {
    const wsService = makeServerConnection(true);
    const store = makeStore({ mode: 'relay', transportReady: false, resize: { cols: 100, rows: 30 } });

    const { rerender } = renderAttachHook({ store, p2p: null, wsService });
    expect(wsService.beginRelay).not.toHaveBeenCalled();

    act(() => {
      store.set(terminalTransportReadyAtom, true);
    });
    rerender();

    expect(wsService.beginRelay).toHaveBeenCalledWith('agent:sess', undefined, 100, 30);
    expect(store.get(terminalSessionStateAtom)).toBe('attached');
  });

  it('P2P: re-sends client.attach after transport rebind while attached', () => {
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p' });

    const { rerender } = renderAttachHook({ store, p2p, wsService });
    expect(p2p.sendMessage).toHaveBeenCalledTimes(1);

    const attachCall = p2p.sendMessage.mock.calls[0][0] as { id: string };
    act(() => {
      for (const h of p2p.getHandlers()) {
        h({ msg_type: 'ok', id: attachCall.id, timestamp: 0, payload: {} });
      }
    });
    expect(store.get(terminalSessionStateAtom)).toBe('attached');

    act(() => {
      store.set(terminalTransportReadyAtom, false);
    });
    rerender();

    act(() => {
      store.set(terminalTransportReadyAtom, true);
    });
    rerender();

    const secondAttach = p2p.sendMessage.mock.calls[1][0] as { id: string };
    act(() => {
      for (const h of p2p.getHandlers()) {
        h({ msg_type: 'ok', id: secondAttach.id, timestamp: 0, payload: {} });
      }
    });

    expect(p2p.sendMessage).toHaveBeenCalledTimes(2);
    expect(p2p.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ msg_type: 'client.attach' }),
    );
    expect(store.get(terminalSessionStateAtom)).toBe('attached');
  });

  it('P2P: exhausts reconnect budget then falls back to relay', () => {
    vi.useFakeTimers();
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p' });

    const { result } = renderAttachHook({ store, p2p, wsService });

    for (let i = 0; i <= P2P_MAX_RECONNECT; i++) {
      act(() => {
        vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
      });
    }

    expect(result.current.terminalState).toBe('connecting');
    expect(store.get(forcedRelayAtom)).toBe(true);
  });

  it('P2P: attach error on manual route fails via runtime attachState', () => {
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p' });
    store.set(manualOverrideAtom, 'ws://manual/ws');

    const { result } = renderAttachHook({ store, p2p, wsService, p2pState: 'connected', runtime: makeRuntime() });

    const attachCall = p2p.sendMessage.mock.calls[0][0] as { id: string };
    act(() => {
      for (const h of p2p.getHandlers()) {
        h({ msg_type: 'error', id: attachCall.id, timestamp: 0, payload: { message: 'bad route' } });
      }
    });

    expect(result.current.terminalState).toBe('failed');
  });

  it('relay: runtime attachState transitions to attached on beginRelay', () => {
    const wsService = makeServerConnection(true);
    const store = makeStore({ mode: 'relay', transportReady: true });
    const runtime = makeRuntime();

    renderAttachHook({ store, p2p: null, wsService, p2pState: 'disconnected', runtime });

    expect(wsService.beginRelay).toHaveBeenCalled();
    expect(store.get(terminalSessionStateAtom)).toBe('attached');
    expect(runtime.attachState.phase).toBe('attached');
  });

  it('P2P: transport disconnect while attached promotes via runtime TRANSPORT_LOST', () => {
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p' });
    const runtime = makeRuntime();

    const { rerender } = renderAttachHook({ store, p2p, wsService, p2pState: 'connected', runtime });

    const attachCall = p2p.sendMessage.mock.calls[0][0] as { id: string };
    act(() => {
      for (const h of p2p.getHandlers()) {
        h({ msg_type: 'ok', id: attachCall.id, timestamp: 0, payload: {} });
      }
    });
    expect(store.get(terminalSessionStateAtom)).toBe('attached');

    rerender({ state: 'disconnected' });

    expect(store.get(terminalSessionStateAtom)).toBe('reconnecting');
    expect(runtime.attachState.phase).toBe('reconnecting');
  });

  it('idle session promotes to connecting through runtime SESSION_SELECTED', () => {
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p', transportReady: true });
    store.set(terminalSessionStateAtom, 'idle');
    const runtime = makeRuntime();

    renderAttachHook({ store, p2p, wsService, p2pState: 'connected', runtime });

    expect(store.get(terminalSessionStateAtom)).toBe('connecting');
    expect(runtime.attachState.phase).toBe('connecting');
  });
});
