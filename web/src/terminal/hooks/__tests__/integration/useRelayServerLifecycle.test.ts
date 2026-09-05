import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { createStore, Provider } from 'jotai';
import { useRelayServerLifecycle } from '@/terminal/hooks/useRelayServerLifecycle';
import { terminalSessionStateAtom, type TerminalStatus } from '@/terminal/state/session';
import type { ConnectionState } from '@/services/socket/types';

/** Fake of the narrow server-connection surface the lifecycle hook consumes. */
function makeServerConnection() {
  const listeners = new Set<(state: ConnectionState) => void>();
  return {
    emit(next: ConnectionState) {
      for (const cb of listeners) {
        cb(next);
      }
    },
    onConnectionStateChange(cb: (state: ConnectionState) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

function renderLifecycle(opts: { status: TerminalStatus; mode?: 'p2p' | 'relay' }) {
  const store = createStore();
  store.set(terminalSessionStateAtom, opts.status);
  const server = makeServerConnection();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { store }, children);

  const { result } = renderHook(
    () => useRelayServerLifecycle({
      effectiveMode: opts.mode ?? 'relay',
      serverConnection: server as never,
      setTerminalState: (u: TerminalStatus | ((prev: TerminalStatus) => TerminalStatus)) => {
        store.set(terminalSessionStateAtom, u as TerminalStatus);
      },
    }),
    { wrapper },
  );
  return { store, server, result };
}

describe('useRelayServerLifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('relay survives an intra-budget server-ws reconnect with exactly one handoff', () => {
    // TerminalWorkspace composition: attach machine holds 'attached'; on
    // 'connecting'/'reconnecting' (intra-budget loss, old collapsed 'connecting')
    // the machine goes reconnecting, and the post-handshake 'connected' handoff
    // promotes to 'connected' so the machine re-begins relay.
    const { store, server, result } = renderLifecycle({ status: 'attached' });
    expect(result.current.relayLost).toBe(false);

    act(() => {
      server.emit('connecting');
    });
    expect(store.get(terminalSessionStateAtom)).toBe('reconnecting');
    expect(result.current.relayLost).toBe(false);

    act(() => {
      server.emit('connected');
    });
    expect(store.get(terminalSessionStateAtom)).toBe('connected');
    expect(result.current.relayLost).toBe(false);
  });

  it('marks relayLost only on budget-exhausted disconnected', () => {
    const { store, server, result } = renderLifecycle({ status: 'attached' });

    act(() => {
      server.emit('disconnected');
    });
    expect(store.get(terminalSessionStateAtom)).toBe('reconnecting');
    expect(result.current.relayLost).toBe(true);

    act(() => {
      server.emit('connected');
    });
    expect(result.current.relayLost).toBe(false);
    expect(store.get(terminalSessionStateAtom)).toBe('connected');
  });

  it('no-ops in p2p mode and does not touch relayLost', () => {
    const { store, server, result } = renderLifecycle({ status: 'attached', mode: 'p2p' });

    act(() => {
      server.emit('connecting');
      server.emit('reconnecting');
      server.emit('disconnected');
      server.emit('connected');
    });
    expect(store.get(terminalSessionStateAtom)).toBe('attached');
    expect(result.current.relayLost).toBe(false);
  });
});
