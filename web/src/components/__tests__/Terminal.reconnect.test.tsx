import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import {
  sessionIdAtom,
  sessionNameAtom,
  attachInfoAtom,
  forcedRelayAtom,
} from '../../atoms/session';
import {
  p2pConnectionAtom,
  terminalSessionStateAtom,
} from '../../atoms/connection';
import type { AttachInfo } from '../../types';
import type { P2PMessage } from '../../hooks/useP2PConnection';
import type { WebSocketService } from '../../services/websocket';

// Capture the imperative calls the state machine effect makes on the engine.
const setExternalBanner = vi.fn();

// Mock only the TerminalView engine; keep the real detectProfile/types so
// Terminal.tsx's `detectProfile(...)` call and named type imports still work.
vi.mock('../../terminal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../terminal')>();
  return {
    ...actual,
    TerminalView: vi.fn(function TerminalViewStub(this: Record<string, unknown>) {
      this.onStateChange = null;
      this.onCtrlD = null;
      this.onError = null;
      this.onDisconnect = null;
      this.setExternalBanner = setExternalBanner;
      this.sendText = vi.fn();
      this.refit = vi.fn();
      this.dispose = vi.fn();
    }),
  };
});

import { Terminal } from '../Terminal';

/**
 * Fake P2PConnection whose connectionState is a getter backed by a mutable
 * closure variable — mirrors the real useP2PConnection contract (identity-stable
 * object, connectionState read fresh at render). Mutating `state` then
 * re-rendering with the SAME element tree reproduces exactly how the owning
 * component (TerminalView) re-renders Terminal on a P2P transport transition.
 * onMessage handlers are captured so tests can simulate agent responses.
 */
function makeP2P(getState: () => string, getAttempt: () => number) {
  const handlers: Array<(msg: P2PMessage) => void> = [];
  const p2p = {
    get connectionState() { return getState(); },
    get reconnectAttempt() { return getAttempt(); },
    sendMessage: vi.fn(),
    onMessage: (cb: (msg: P2PMessage) => void) => {
      handlers.push(cb);
      return () => {};
    },
    close: vi.fn(),
    waitForConnection: () => Promise.resolve(),
  };
  return { p2p, handlers };
}

function makeAttachInfo(mode: 'p2p' | 'relay'): AttachInfo {
  return { mode, session_id: 'a:s', session_name: 's', addresses: [] };
}

/**
 * Render Terminal with a p2p session wired through the jotai atoms. `state`
 * and `attempt` back the getters on the (identity-stable) connection object;
 * rerendering with the same element tree forces Terminal to re-read the
 * getters, mirroring a parent re-render in production.
 */
function renderWithP2P(
  getState: () => string,
  getAttempt: () => number,
  mode: 'p2p' | 'relay' = 'p2p',
  serverConnection?: WebSocketService,
) {
  const store = createStore();
  store.set(sessionIdAtom, 'a:s');
  store.set(sessionNameAtom, 's');
  store.set(attachInfoAtom, makeAttachInfo(mode));
  store.set(forcedRelayAtom, false);
  store.set(terminalSessionStateAtom, 'attached');
  const { p2p, handlers } = makeP2P(getState, getAttempt);
  store.set(p2pConnectionAtom, p2p as never);

  const { rerender } = render(
    <Provider store={store}>
      <Terminal serverConnection={serverConnection} />
    </Provider>,
  );
  return {
    p2p,
    handlers,
    // Build a FRESH element tree on each rerender — React bails out when the
    // same element reference is reused, so a recreated tree is what actually
    // re-invokes Terminal and re-reads the getter-backed connectionState.
    rerender: () => rerender(
      <Provider store={store}>
        <Terminal serverConnection={serverConnection} />
      </Provider>,
    ),
  };
}

describe('Terminal session state machine reconnect', () => {
  beforeEach(() => {
    setExternalBanner.mockClear();
  });

  it('enters reconnecting on transport drop and re-attaches on recovery', async () => {
    let state = 'connected';
    let attempt = 0;
    const { p2p, handlers, rerender } = renderWithP2P(() => state, () => attempt);

    // Let the view-creation effect populate viewRef.current.
    await new Promise((r) => { setTimeout(r, 60); });
    setExternalBanner.mockClear();

    // Transport drops → the bridge moves the state machine to 'reconnecting'.
    state = 'reconnecting';
    rerender();
    expect(setExternalBanner).toHaveBeenCalledWith('reconnecting', 1);

    // Transport recovers → bridge moves to 'connected' → client.attach re-sent.
    setExternalBanner.mockClear();
    state = 'connected';
    attempt = 0;
    rerender();
    expect(p2p.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ msg_type: 'client.attach' }),
    );

    // Agent acks the attach → 'attached' → banner cleared.
    setExternalBanner.mockClear();
    const attachCall = (p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).msg_type === 'client.attach',
    );
    const attachId = (attachCall![0] as { id: string }).id;
    act(() => {
      handlers.forEach((h) =>
        h({ id: attachId, msg_type: 'ok', timestamp: 0, payload: {} } as P2PMessage),
      );
    });
    expect(setExternalBanner).toHaveBeenCalledWith('none', 0);
  });

  it('relay: beginRelay fires from server auth and the banner is cleared', async () => {
    const store = createStore();
    store.set(sessionIdAtom, 'a:s');
    store.set(sessionNameAtom, 's');
    store.set(attachInfoAtom, makeAttachInfo('relay'));
    store.set(forcedRelayAtom, false);
    store.set(terminalSessionStateAtom, 'connecting');
    store.set(p2pConnectionAtom, null);

    const beginRelay = vi.fn();
    const serverConnection = { isConnected: () => true, beginRelay } as unknown as WebSocketService;

    render(
      <Provider store={store}>
        <Terminal serverConnection={serverConnection} />
      </Provider>,
    );
    // The state machine runs connecting → connected → attached synchronously
    // (the server is already authenticated), firing beginRelay once.
    await new Promise((r) => { setTimeout(r, 60); });

    expect(beginRelay).toHaveBeenCalledTimes(1);
    expect(beginRelay).toHaveBeenCalledWith('a:s', undefined, undefined, undefined);
    expect(setExternalBanner).toHaveBeenCalledWith('none', 0);
  });

  it('relay: p2pState transitions do not drive the state machine', async () => {
    let state = 'connected';
    const { p2p, rerender } = renderWithP2P(() => state, () => 0, 'relay');
    await new Promise((r) => { setTimeout(r, 60); });
    setExternalBanner.mockClear();

    state = 'reconnecting';
    rerender();

    // The bridge early-returns for relay mode — no banner, no re-attach.
    expect(setExternalBanner).not.toHaveBeenCalled();
    expect(p2p.sendMessage).not.toHaveBeenCalled();
  });
});
