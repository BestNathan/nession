import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

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
 * object, connectionState read fresh at render). Mutating `state` then re-rendering
 * with the SAME props object reproduces exactly how the owning component re-renders
 * Terminal on a P2P transport transition.
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

describe('Terminal P2P reconnect observer', () => {
  beforeEach(() => {
    setExternalBanner.mockClear();
    reattach.mockClear();
  });

  it('shows reconnecting banner when P2P state becomes reconnecting, and reattaches on recovery', async () => {
    let state = 'connected';
    let attempt = 3;
    const p2p = makeP2P(() => state, () => attempt);
    const props = {
      sessionId: 'a:s',
      sessionName: 's',
      mode: 'p2p' as const,
      p2pConnection: p2p as never,
    };

    const { rerender } = render(<Terminal {...props} />);

    // Let the engine-creation effect populate viewRef.current.
    await new Promise((r) => { setTimeout(r, 60); });

    // Transition: connected -> reconnecting (mutate getter-backed state, re-render).
    state = 'reconnecting';
    rerender(<Terminal {...props} />);
    expect(setExternalBanner).toHaveBeenCalledWith('reconnecting', 3);

    // Recovery: reconnecting -> connected (should clear banner and reattach).
    setExternalBanner.mockClear();
    state = 'connected';
    attempt = 0;
    rerender(<Terminal {...props} />);
    expect(setExternalBanner).toHaveBeenCalledWith('none', 0);
    expect(reattach).toHaveBeenCalled();
  });

  it('does not drive the banner when mode is relay', async () => {
    let state = 'connected';
    const p2p = makeP2P(() => state, () => 0);
    const props = {
      sessionId: 'a:s',
      sessionName: 's',
      mode: 'relay' as const,
      p2pConnection: p2p as never,
    };

    const { rerender } = render(<Terminal {...props} />);
    await new Promise((r) => { setTimeout(r, 60); });

    state = 'reconnecting';
    rerender(<Terminal {...props} />);
    expect(setExternalBanner).not.toHaveBeenCalled();
  });
});
