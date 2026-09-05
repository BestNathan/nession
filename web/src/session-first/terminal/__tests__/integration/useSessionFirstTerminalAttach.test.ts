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
import type { ConnectionState } from '@/services/socket/types';
import type { AttachResult, TerminalAgentApi } from '@/features/terminal';
import { AttachStateMachine, type AttachPhase } from '@/runtime/AttachStateMachine';
import { SessionAttachController } from '@/runtime/SessionAttachController';
import type { SessionRuntime } from '@/runtime/SessionRuntime';

/** Two microtask ticks — enough for a resolved attach's .then chain to run. */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

interface AgentApiHarness {
  api: TerminalAgentApi;
  attach: ReturnType<typeof vi.fn>;
  /** Resolvers in call order — resolve attach call N via attachResolvers[N]. */
  attachResolvers: Array<(result: AttachResult) => void>;
}

/** Deferred attach — the test controls when (and with what) attach resolves. */
function makeAgentApi(): AgentApiHarness {
  const attachResolvers: Array<(result: AttachResult) => void> = [];
  const attach = vi.fn((): Promise<AttachResult> => new Promise((resolve) => {
    attachResolvers.push(resolve);
  }));
  const api = {
    attach,
    sendInput: vi.fn(),
    sendResize: vi.fn(),
    onOutput: vi.fn(() => () => {}),
    onResize: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    ping: vi.fn(),
  };
  return { api: api as unknown as TerminalAgentApi, attach, attachResolvers };
}

/** Attach resolves { ok: false, error: 'timeout' } on its own timeout budget. */
function makeTimedAgentApi(): AgentApiHarness {
  const attach = vi.fn(
    (_sessionName: string, _size?: unknown, opts?: { timeoutMs?: number }): Promise<AttachResult> =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ ok: false, error: 'timeout' }), opts?.timeoutMs ?? ATTACH_TIMEOUT_MS);
      }),
  );
  const api = {
    attach,
    sendInput: vi.fn(),
    sendResize: vi.fn(),
    onOutput: vi.fn(() => () => {}),
    onResize: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    ping: vi.fn(),
  };
  return { api: api as unknown as TerminalAgentApi, attach, attachResolvers: [] };
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
    agentTerminalApi: TerminalAgentApi | null;
  };
  maybeStartP2PAttach(): void;
  notifyP2pState(next: ConnectionState): void;
  setTransportReady(value: boolean): void;
}

function makeRuntime(opts: {
  api: TerminalAgentApi;
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
      agentApi: opts.api,
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
      connectionState: 'connected',
      agentTerminalApi: opts.api,
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
  };
}

function asSessionRuntime(runtime: MockP2pRuntime | SessionRuntime): SessionRuntime {
  // The tests drive a minimal runtime twin (attach state machine + controller +
  // mirror snapshot); the hook only consumes those members.
  return runtime as SessionRuntime;
}

function makeRelayRuntime(): MockP2pRuntime {
  const attachState = new AttachStateMachine({ transportFirst: true });
  return {
    attachState,
    attachController: new SessionAttachController(attachState),
    getMirrorSnapshot: () => ({
      phase: attachState.phase as AttachPhase,
      transportGeneration: 0,
      connectionState: 'disconnected' as const,
      agentTerminalApi: null,
    }),
    maybeStartP2PAttach: () => {},
    notifyP2pState: () => {},
    setTransportReady: () => {},
  };
}

function renderAttachHook(opts: {
  store: ReturnType<typeof makeStore>;
  api?: TerminalAgentApi | null;
  runtime?: MockP2pRuntime | SessionRuntime | null;
}) {
  const { store, api } = opts;
  const runtime = opts.runtime ?? (api
    ? makeRuntime({ api, sessionName: store.get(sessionNameAtom) })
    : makeRelayRuntime());
  return renderHook(
    () =>
      useSessionFirstTerminalAttach({
        sessionId: store.get(sessionIdAtom),
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
    const { api, attach } = makeAgentApi();
    const store = makeStore({ mode: 'p2p', transportReady: false });
    const runtime = makeRuntime({ api, transportReady: false });

    renderAttachHook({ store, api, runtime });
    expect(attach).not.toHaveBeenCalled();

    act(() => {
      store.set(terminalTransportReadyAtom, true);
      runtime.setTransportReady(true);
      runtime.maybeStartP2PAttach();
    });

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith('sess', undefined, { timeoutMs: ATTACH_TIMEOUT_MS });
  });

  it('P2P: mirrors attach ok outcome to attached', async () => {
    const { api, attach, attachResolvers } = makeAgentApi();
    const store = makeStore({ mode: 'p2p', resize: { cols: 80, rows: 24 } });
    const runtime = makeRuntime({ api });

    const { result } = renderAttachHook({ store, api, runtime });
    act(() => {
      runtime.maybeStartP2PAttach();
    });
    expect(attach).toHaveBeenCalledTimes(1);

    await act(async () => {
      attachResolvers[0]?.({ ok: true });
      await flushMicrotasks();
    });

    expect(result.current.terminalState).toBe('attached');
  });

  it('P2P: mirrors attach timeout outcome to reconnecting', async () => {
    vi.useFakeTimers();
    const { api } = makeTimedAgentApi();
    const store = makeStore({ mode: 'p2p' });
    const runtime = makeRuntime({ api });

    const { result } = renderAttachHook({ store, api, runtime });
    act(() => {
      runtime.maybeStartP2PAttach();
    });

    await act(async () => {
      vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
      await flushMicrotasks();
    });

    expect(result.current.terminalState).toBe('reconnecting');
    expect(result.current.reconnectCount).toBe(1);
  });

  it('relay: driver sends no beginRelay; mirror reflects runtime RELAY_BEGIN_OK', () => {
    const store = makeStore({ mode: 'relay', transportReady: true });
    const runtime = makeRelayRuntime();
    const { result } = renderAttachHook({ store, api: null, runtime });

    // The mirror promotes the idle session and reflects controller outcomes.
    act(() => {
      runtime.attachController.dispatch({ type: 'SESSION_SELECTED' });
    });
    expect(store.get(terminalSessionStateAtom)).toBe('connecting');

    act(() => {
      const outcome = runtime.attachController.dispatch({ type: 'RELAY_BEGIN_OK' });
      expect(outcome.phase).toBe('attached');
    });
    expect(result.current.terminalState).toBe('attached');
    expect(runtime.attachState.phase).toBe('attached');
  });

  it('P2P: runtime re-attach after transport rebind while attached', async () => {
    const { api, attach, attachResolvers } = makeAgentApi();
    const store = makeStore({ mode: 'p2p' });
    const runtime = makeRuntime({ api });

    renderAttachHook({ store, api, runtime });
    act(() => {
      runtime.maybeStartP2PAttach();
    });
    expect(attach).toHaveBeenCalledTimes(1);

    await act(async () => {
      attachResolvers[0]?.({ ok: true });
      await flushMicrotasks();
    });
    expect(store.get(terminalSessionStateAtom)).toBe('attached');

    act(() => {
      runtime.notifyP2pState('connecting');
      runtime.maybeStartP2PAttach();
    });

    expect(attach).toHaveBeenCalledTimes(2);

    await act(async () => {
      attachResolvers[1]?.({ ok: true });
      await flushMicrotasks();
    });

    expect(store.get(terminalSessionStateAtom)).toBe('attached');
  });

  it('P2P: mirrors force-relay outcome after reconnect budget exhausted', async () => {
    vi.useFakeTimers();
    const { api } = makeTimedAgentApi();
    const store = makeStore({ mode: 'p2p' });
    const runtime = makeRuntime({ api });

    const { result } = renderAttachHook({ store, api, runtime });

    for (let i = 0; i <= P2P_MAX_RECONNECT; i += 1) {
      await act(async () => {
        runtime.maybeStartP2PAttach();
        vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
        await flushMicrotasks();
      });
    }

    expect(result.current.terminalState).toBe('connecting');
    expect(store.get(forcedRelayAtom)).toBe(true);
  });

  it('P2P: mirrors attach error on manual route to failed', async () => {
    const { api, attachResolvers } = makeAgentApi();
    const store = makeStore({ mode: 'p2p' });
    store.set(manualOverrideAtom, 'ws://manual/ws');
    const runtime = makeRuntime({ api, manualRoute: true });

    const { result } = renderAttachHook({ store, api, runtime });
    act(() => {
      runtime.maybeStartP2PAttach();
    });

    await act(async () => {
      attachResolvers[0]?.({ ok: false, error: 'bad route' });
      await flushMicrotasks();
    });

    expect(result.current.terminalState).toBe('failed');
  });

  it('P2P: mirrors transport disconnect while attached via runtime TRANSPORT_LOST', async () => {
    const { api, attachResolvers } = makeAgentApi();
    const store = makeStore({ mode: 'p2p' });
    const runtime = makeRuntime({ api });

    renderAttachHook({ store, api, runtime });
    act(() => {
      runtime.maybeStartP2PAttach();
    });

    await act(async () => {
      attachResolvers[0]?.({ ok: true });
      await flushMicrotasks();
    });
    expect(store.get(terminalSessionStateAtom)).toBe('attached');

    act(() => {
      runtime.notifyP2pState('disconnected');
    });

    expect(store.get(terminalSessionStateAtom)).toBe('reconnecting');
    expect(runtime.attachState.phase).toBe('reconnecting');
  });

  it('idle session promotes to connecting through runtime SESSION_SELECTED', () => {
    const { api } = makeAgentApi();
    const store = makeStore({ mode: 'p2p', transportReady: true });
    store.set(terminalSessionStateAtom, 'idle');
    const runtime = makeRuntime({ api });

    renderAttachHook({ store, api, runtime });

    expect(store.get(terminalSessionStateAtom)).toBe('connecting');
    expect(runtime.attachState.phase).toBe('connecting');
  });

  it('remount mirrors runtime phase without resetting attach state', () => {
    const { api } = makeAgentApi();
    const store = makeStore({ mode: 'p2p' });
    const runtime = makeRuntime({ api });

    const { unmount } = renderAttachHook({ store, api, runtime });
    act(() => {
      runtime.attachController.dispatch({ type: 'SESSION_SELECTED' });
      runtime.attachController.dispatch({ type: 'ATTACH_OK' });
    });
    expect(runtime.attachState.phase).toBe('attached');

    unmount();
    const { result } = renderAttachHook({ store, api, runtime });
    expect(result.current.terminalState).toBe('attached');
    expect(runtime.attachState.phase).toBe('attached');
  });
});
