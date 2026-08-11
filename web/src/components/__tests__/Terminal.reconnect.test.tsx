import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import {
  sessionIdAtom,
  sessionNameAtom,
  attachInfoAtom,
  forcedRelayAtom,
  p2pConnectionAtom,
} from '../../atoms/terminal';
import type { AttachInfo } from '../../types';

// Capture the imperative calls the React observer effect makes on the engine.
const setExternalBanner = vi.fn();
const reattach = vi.fn();

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
      this.reattach = reattach;
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
 */
function makeP2P(getState: () => string, getAttempt: () => number) {
  return {
    get connectionState() { return getState(); },
    get reconnectAttempt() { return getAttempt(); },
    sendMessage: vi.fn(),
    onMessage: () => () => {},
    close: vi.fn(),
    waitForConnection: () => Promise.resolve(),
  };
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
function renderWithP2P(getState: () => string, getAttempt: () => number, mode: 'p2p' | 'relay' = 'p2p') {
  const store = createStore();
  store.set(sessionIdAtom, 'a:s');
  store.set(sessionNameAtom, 's');
  store.set(attachInfoAtom, makeAttachInfo(mode));
  store.set(forcedRelayAtom, false);
  const p2p = makeP2P(getState, getAttempt);
  store.set(p2pConnectionAtom, p2p as never);

  const { rerender } = render(
    <Provider store={store}>
      <Terminal />
    </Provider>,
  );
  return {
    p2p,
    // Build a FRESH element tree on each rerender — React bails out when the
    // same element reference is reused, so a recreated tree is what actually
    // re-invokes Terminal and re-reads the getter-backed connectionState.
    rerender: () => rerender(
      <Provider store={store}>
        <Terminal />
      </Provider>,
    ),
  };
}

describe('Terminal P2P reconnect observer', () => {
  beforeEach(() => {
    setExternalBanner.mockClear();
    reattach.mockClear();
  });

  it('shows reconnecting banner when P2P state becomes reconnecting, and reattaches on recovery', async () => {
    let state = 'connected';
    let attempt = 3;
    const { rerender } = renderWithP2P(() => state, () => attempt);

    // Let the engine-creation effect populate viewRef.current.
    await new Promise((r) => { setTimeout(r, 60); });

    // Transition: connected -> reconnecting (mutate getter-backed state, re-render).
    state = 'reconnecting';
    rerender();
    expect(setExternalBanner).toHaveBeenCalledWith('reconnecting', 3);

    // Recovery: reconnecting -> connected (should clear banner and reattach).
    setExternalBanner.mockClear();
    state = 'connected';
    attempt = 0;
    rerender();
    expect(setExternalBanner).toHaveBeenCalledWith('none', 0);
    expect(reattach).toHaveBeenCalled();
  });

  it('does not drive the banner when mode is relay', async () => {
    let state = 'connected';
    const { rerender } = renderWithP2P(() => state, () => 0, 'relay');
    await new Promise((r) => { setTimeout(r, 60); });

    state = 'reconnecting';
    rerender();
    expect(setExternalBanner).not.toHaveBeenCalled();
  });
});
