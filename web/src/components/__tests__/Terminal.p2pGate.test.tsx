import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import {
  sessionIdAtom,
  sessionNameAtom,
  attachInfoAtom,
  forcedRelayAtom,
} from '../../atoms/session';
import { p2pConnectionAtom } from '../../atoms/connection';
import type { AttachInfo } from '../../types';

// Track TerminalView construction + disposal so we can assert the view is
// built exactly once, only after a p2p connection exists.
const ctorCalls: Array<{ mode: string; hasConn: boolean }> = [];
const disposeSpy = vi.fn();

vi.mock('../../terminal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../terminal')>();
  return {
    ...actual,
    TerminalView: vi.fn(function TerminalViewStub(
      this: Record<string, unknown>,
      _container: HTMLElement,
      options: { connection: { mode: string; p2pConnection?: unknown } },
    ) {
      ctorCalls.push({
        mode: options.connection.mode,
        hasConn: options.connection.p2pConnection !== undefined,
      });
      this.onStateChange = null;
      this.onCtrlD = null;
      this.onError = null;
      this.onDisconnect = null;
      this.setExternalBanner = vi.fn();
      this.reattach = vi.fn();
      this.sendText = vi.fn();
      this.refit = vi.fn();
      this.dispose = disposeSpy;
    }),
  };
});

import { Terminal } from '../Terminal';

function makeP2P(state = 'connected') {
  return {
    get connectionState() { return state; },
    get reconnectAttempt() { return 0; },
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
 * Set the session atoms to a p2p (or relay) session on the given store.
 * effectiveModeAtom derives 'p2p'/'relay' from attachInfoAtom.mode and
 * forcedRelayAtom, so this is all Terminal needs to pick its mode.
 */
function setupSession(store: ReturnType<typeof createStore>, mode: 'p2p' | 'relay') {
  store.set(sessionIdAtom, 'a:s');
  store.set(sessionNameAtom, 's');
  store.set(attachInfoAtom, makeAttachInfo(mode));
  store.set(forcedRelayAtom, false);
}

/** Render Terminal with session atoms isolated per test via a fresh store. */
function renderTerminal(store = createStore()) {
  return {
    store,
    ...render(
      <Provider store={store}>
        <Terminal />
      </Provider>,
    ),
  };
}

describe('Terminal p2p connection gate (issue #51)', () => {
  beforeEach(() => {
    ctorCalls.length = 0;
    disposeSpy.mockClear();
  });

  it('does NOT build the xterm view in p2p mode while p2pConnection is null', async () => {
    // First render: address plan still resolving → connection is null but
    // mode is already 'p2p'. Building here (then disposing when the connection
    // arrives one render later) is what left xterm's Viewport setTimeout
    // firing against a disposed RenderService and crashing on `.dimensions`.
    const store = createStore();
    setupSession(store, 'p2p');
    store.set(p2pConnectionAtom, null);
    renderTerminal(store);
    await new Promise((r) => { setTimeout(r, 60); });

    expect(ctorCalls).toHaveLength(0);
    expect(disposeSpy).not.toHaveBeenCalled();
  });

  it('builds the view exactly once — only after the connection resolves', async () => {
    const p2p = makeP2P();
    const store = createStore();
    setupSession(store, 'p2p');

    // Render 1: connection still null (plan resolving).
    store.set(p2pConnectionAtom, null);
    renderTerminal(store);
    await new Promise((r) => { setTimeout(r, 60); });
    expect(ctorCalls).toHaveLength(0);

    // Render 2: connection object arrives (identity-stable henceforth).
    // Writing p2pConnectionAtom notifies Terminal (which subscribes to it), so
    // the view-build effect re-runs with a live connection.
    store.set(p2pConnectionAtom, p2p as never);
    await new Promise((r) => { setTimeout(r, 60); });

    // Exactly one construction, with a live connection, and no churn.
    expect(ctorCalls).toEqual([{ mode: 'p2p', hasConn: true }]);
    expect(disposeSpy).not.toHaveBeenCalled();
  });

  it('relay mode builds immediately (no connection gating)', async () => {
    const store = createStore();
    setupSession(store, 'relay');
    render(
      <Provider store={store}>
        <Terminal serverConnection={{ isConnected: () => true } as never} />
      </Provider>,
    );
    await new Promise((r) => { setTimeout(r, 60); });

    expect(ctorCalls).toEqual([{ mode: 'relay', hasConn: false }]);
  });
});
