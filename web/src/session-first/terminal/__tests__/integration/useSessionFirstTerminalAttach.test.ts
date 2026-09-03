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
import { AttachStateMachine, type AttachPhase } from '@/runtime/AttachStateMachine';
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

interface MockP2pRuntime {
  attachState: AttachStateMachine;
  attachController: SessionAttachController;
  getMirrorSnapshot(): {
    phase: AttachPhase;
    transportGeneration: number;
    connectionState: ConnectionState;
    p2pConnection: P2PConnection;
  };
  maybeStartP2PAttach(): void;
  notifyP2pState(next: ConnectionState): void;
  setTransportReady(value: boolean): void;
}

function makeRuntime(opts: {
  p2p: P2PConnection;
  sessionName?: string;
  manualRoute?: boolean;
  transportReady?: boolean;
}): MockP2pRuntime {
  const attachState = new AttachStateMachine({ transportFirst: true });
  const attachController = new SessionAttachController(attachState);
  let transportReady = opts.transportReady ?? true;
  let attachedGen: number | null = null;
  const transportGen = 0;

  attachController.subscribeOutcomes((result) => {
    if (result.phase === 'attached') {
      attachedGen = transportGen;
    }
  });

  const maybeStartP2PAttach = () => {
    if (opts.p2p.connectionState !== 'connected') {
      return;
    }
    const phase = attachState.phase;
    if (phase === 'attached' && attachedGen === transportGen) {
      return;
    }
    if (phase === 'idle' || phase === 'failed') {
      return;
    }
    if (!attachController.canStartAttach(transportReady, true, false, 'p2p')) {
      return;
    }
    attachController.startP2PAttach({
      sessionName: opts.sessionName ?? 'sess',
      p2pConnection: opts.p2p,
      manualRoute: opts.manualRoute ?? false,
      lastResize: null,
      transportGeneration: transportGen,
    });
  };

  return {
    attachState,
    attachController,
    getMirrorSnapshot: () => ({
      phase: attachState.phase as AttachPhase,
      transportGeneration: transportGen,
      connectionState: opts.p2p.connectionState,
      p2pConnection: opts.p2p,
    }),
    setTransportReady(value: boolean) {
      transportReady = value;
    },
    maybeStartP2PAttach,
    notifyP2pState(next: ConnectionState) {
      if (attachState.phase !== 'attached') {
        return;
      }
      if (next === 'reconnecting' || next === 'connecting' || next === 'disconnected') {
        attachedGen = null;
        attachController.dispatch({ type: 'TRANSPORT_LOST' });
      }
    },
  } as MockP2pRuntime;
}

function asSessionRuntime(runtime: MockP2pRuntime | SessionRuntime): SessionRuntime {
  return runtime as SessionRuntime;
}

function makeRelayRuntime(): SessionRuntime {
  const attachState = new AttachStateMachine({ transportFirst: true });
  return {
    attachState,
    attachController: new SessionAttachController(attachState),
    getMirrorSnapshot: () => ({
      phase: attachState.phase,
      transportGeneration: 0,
      connectionState: 'disconnected' as const,
      p2pConnection: null,
    }),
  } as SessionRuntime;
}

function renderAttachHook(opts: {
  store: ReturnType<typeof makeStore>;
  p2p: ReturnType<typeof makeP2PConnection> | null;
  wsService: WebSocketService;
  runtime?: MockP2pRuntime | SessionRuntime | null;
}) {
  const { store, p2p, wsService } = opts;
  const runtime = opts.runtime ?? (p2p
    ? makeRuntime({ p2p: p2p.conn, sessionName: store.get(sessionNameAtom) })
    : makeRelayRuntime());
  return renderHook(
    () =>
      useSessionFirstTerminalAttach({
        sessionId: store.get(sessionIdAtom),
        sessionName: store.get(sessionNameAtom),
        p2pConnection: p2p?.conn ?? null,
        p2pState: p2p?.conn.connectionState ?? 'disconnected',
        wsService,
        runtime: asSessionRuntime(runtime),
      }),
    {
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

  it('P2P: mirrors runtime attach when transport becomes ready', () => {
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p', transportReady: false });
    const runtime = makeRuntime({ p2p: p2p.conn, transportReady: false });

    renderAttachHook({ store, p2p, wsService, runtime });
    expect(p2p.sendMessage).not.toHaveBeenCalled();

    act(() => {
      store.set(terminalTransportReadyAtom, true);
      runtime.setTransportReady(true);
      runtime.maybeStartP2PAttach();
    });

    expect(p2p.sendMessage).toHaveBeenCalledTimes(1);
    expect(p2p.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ msg_type: 'client.attach' }),
    );
  });

  it('P2P: mirrors attach ok outcome to attached', () => {
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p', resize: { cols: 80, rows: 24 } });
    const runtime = makeRuntime({ p2p: p2p.conn });

    const { result } = renderAttachHook({ store, p2p, wsService, runtime });
    act(() => {
      runtime.maybeStartP2PAttach();
    });

    const attachCall = p2p.sendMessage.mock.calls[0][0] as { id: string };
    act(() => {
      for (const h of p2p.getHandlers()) {
        h({ msg_type: 'ok', id: attachCall.id, timestamp: 0, payload: {} });
      }
    });

    expect(result.current.terminalState).toBe('attached');
  });

  it('P2P: mirrors attach timeout outcome to reconnecting', () => {
    vi.useFakeTimers();
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p' });
    const runtime = makeRuntime({ p2p: p2p.conn });

    const { result } = renderAttachHook({ store, p2p, wsService, runtime });
    act(() => {
      runtime.maybeStartP2PAttach();
    });

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

  it('P2P: runtime re-attach after transport rebind while attached', () => {
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p' });
    const runtime = makeRuntime({ p2p: p2p.conn });

    renderAttachHook({ store, p2p, wsService, runtime });
    act(() => {
      runtime.maybeStartP2PAttach();
    });
    expect(p2p.sendMessage).toHaveBeenCalledTimes(1);

    const attachCall = p2p.sendMessage.mock.calls[0][0] as { id: string };
    act(() => {
      for (const h of p2p.getHandlers()) {
        h({ msg_type: 'ok', id: attachCall.id, timestamp: 0, payload: {} });
      }
    });
    expect(store.get(terminalSessionStateAtom)).toBe('attached');

    act(() => {
      runtime.notifyP2pState('connecting');
      runtime.maybeStartP2PAttach();
    });

    const secondAttach = p2p.sendMessage.mock.calls[1][0] as { id: string };
    act(() => {
      for (const h of p2p.getHandlers()) {
        h({ msg_type: 'ok', id: secondAttach.id, timestamp: 0, payload: {} });
      }
    });

    expect(p2p.sendMessage).toHaveBeenCalledTimes(2);
    expect(store.get(terminalSessionStateAtom)).toBe('attached');
  });

  it('P2P: mirrors force-relay outcome after reconnect budget exhausted', () => {
    vi.useFakeTimers();
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p' });
    const runtime = makeRuntime({ p2p: p2p.conn });

    const { result } = renderAttachHook({ store, p2p, wsService, runtime });

    for (let i = 0; i <= P2P_MAX_RECONNECT; i += 1) {
      act(() => {
        runtime.maybeStartP2PAttach();
        vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
      });
    }

    expect(result.current.terminalState).toBe('connecting');
    expect(store.get(forcedRelayAtom)).toBe(true);
  });

  it('P2P: mirrors attach error on manual route to failed', () => {
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p' });
    store.set(manualOverrideAtom, 'ws://manual/ws');
    const runtime = makeRuntime({ p2p: p2p.conn, manualRoute: true });

    const { result } = renderAttachHook({ store, p2p, wsService, runtime });
    act(() => {
      runtime.maybeStartP2PAttach();
    });

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
    const attachState = new AttachStateMachine({ transportFirst: true });
    const runtime = {
      attachState,
      attachController: new SessionAttachController(attachState),
      getMirrorSnapshot: () => ({
        phase: attachState.phase,
        transportGeneration: 0,
        connectionState: 'disconnected' as const,
        p2pConnection: null,
      }),
    } as SessionRuntime;

    renderAttachHook({ store, p2p: null, wsService, runtime });

    expect(wsService.beginRelay).toHaveBeenCalled();
    expect(store.get(terminalSessionStateAtom)).toBe('attached');
    expect(runtime.attachState.phase).toBe('attached');
  });

  it('P2P: mirrors transport disconnect while attached via runtime TRANSPORT_LOST', () => {
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p' });
    const runtime = makeRuntime({ p2p: p2p.conn });

    renderAttachHook({ store, p2p, wsService, runtime });
    act(() => {
      runtime.maybeStartP2PAttach();
    });

    const attachCall = p2p.sendMessage.mock.calls[0][0] as { id: string };
    act(() => {
      for (const h of p2p.getHandlers()) {
        h({ msg_type: 'ok', id: attachCall.id, timestamp: 0, payload: {} });
      }
    });
    expect(store.get(terminalSessionStateAtom)).toBe('attached');

    act(() => {
      runtime.notifyP2pState('disconnected');
    });

    expect(store.get(terminalSessionStateAtom)).toBe('reconnecting');
    expect(runtime.attachState.phase).toBe('reconnecting');
  });

  it('idle session promotes to connecting through runtime SESSION_SELECTED', () => {
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p', transportReady: true });
    store.set(terminalSessionStateAtom, 'idle');
    const runtime = makeRuntime({ p2p: p2p.conn });

    renderAttachHook({ store, p2p, wsService, runtime });

    expect(store.get(terminalSessionStateAtom)).toBe('connecting');
    expect(runtime.attachState.phase).toBe('connecting');
  });

  it('remount mirrors runtime phase without resetting attach state', () => {
    const p2p = makeP2PConnection();
    const wsService = makeServerConnection(false);
    const store = makeStore({ mode: 'p2p' });
    const runtime = makeRuntime({ p2p: p2p.conn });

    const { unmount } = renderAttachHook({ store, p2p, wsService, runtime });
    act(() => {
      runtime.attachController.dispatch({ type: 'SESSION_SELECTED' });
      runtime.attachController.dispatch({ type: 'ATTACH_OK' });
    });
    expect(runtime.attachState.phase).toBe('attached');

    unmount();
    const { result } = renderAttachHook({ store, p2p, wsService, runtime });
    expect(result.current.terminalState).toBe('attached');
    expect(runtime.attachState.phase).toBe('attached');
  });
});
