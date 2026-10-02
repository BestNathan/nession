// @vitest-environment jsdom
/**
 * Composition test for issue #598: the first onTransportReady(true) must not be
 * lost to adapter binding order.
 *
 * TerminalViewport attaches the controller in a useLayoutEffect (layout phase);
 * the runtime adapter used to be bound later, in useTerminal's passive effect.
 * A readiness event published by the layout-phase attach was therefore dropped
 * and never replayed — terminalTransportReadyAtom stayed false and the
 * SessionRuntime's relay attach (gated on transportReady) never began.
 *
 * This renders the REAL useTerminal hook + REAL TerminalViewport and asserts
 * the atom flips true once the viewport attaches, exactly as production does.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { useTerminal } from '@/product/terminal/hooks/useTerminal';
import { TerminalViewport } from '@/product/terminal/components/TerminalViewport';
import { terminalTransportReadyAtom } from '@/product/terminal/state/transport';
import type { TerminalTransport } from '@/platform/terminal-runtime/transport/TerminalTransport';
import type { SessionRuntime } from '@/platform/session-runtime/SessionRuntime';

// xterm.open() requires window.matchMedia in jsdom (same stub as
// TerminalController.test.ts).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

function makeTransport(): TerminalTransport {
  return {
    mode: 'relay',
    send: vi.fn<(data: string) => void>(),
    sendResize: vi.fn<(cols: number, rows: number) => void>(),
    flushInputBuffer: vi.fn<() => void>(),
    flushPendingResize: vi.fn<() => void>(),
    flushAllOutbound: vi.fn<() => void>(),
    onOutput: null,
    onResize: null,
    onStateChange: null,
    onError: null,
    onDisconnect: null,
    dispose: vi.fn<() => void>(),
  };
}

/**
 * A SessionRuntime stub with the three members useTerminal and the runtime
 * adapter touch: it builds transports, pushes swap notifications, and takes
 * readiness/resize facts. One stub per test — a new identity per render would
 * recreate the controller every render (runtime is a useTerminal memo dep).
 */
function makeRuntimeStub(): { runtime: SessionRuntime; emitSwap: () => void } {
  const swapListeners = new Set<() => void>();
  const runtime = {
    buildTransport: () => makeTransport(),
    subscribeTransportSwap: (listener: () => void) => {
      swapListeners.add(listener);
      return () => { swapListeners.delete(listener); };
    },
    setTransportReady: () => {},
    updateViewportSize: () => {},
  } as unknown as SessionRuntime;
  return {
    runtime,
    emitSwap: () => {
      for (const listener of [...swapListeners]) { listener(); }
    },
  };
}

function Harness({ sessionId, runtime }: { sessionId: string; runtime: SessionRuntime }) {
  const controller = useTerminal({
    sessionId,
    sessionName: 'sess',
    mode: 'relay',
    runtime,
    rendererType: 'canvas',
  });
  return <TerminalViewport controller={controller} />;
}

describe('useTerminal + TerminalViewport transport readiness', () => {
  afterEach(() => {
    cleanup();
  });

  it('publishes transportReady=true when the viewport attaches on first mount', () => {
    const store = getDefaultStore();
    store.set(terminalTransportReadyAtom, false);
    const { runtime } = makeRuntimeStub();

    render(<Harness sessionId="agent1:sess" runtime={runtime} />);

    // The layout-phase attach must reach the atom even though no passive
    // effect has run yet (issue #598 — the event used to be lost here).
    expect(store.get(terminalTransportReadyAtom)).toBe(true);
  });

  it('republishes readiness across a transport swap (same controller)', () => {
    const store = getDefaultStore();
    store.set(terminalTransportReadyAtom, false);
    const { runtime, emitSwap } = makeRuntimeStub();

    render(<Harness sessionId="agent1:sess" runtime={runtime} />);
    expect(store.get(terminalTransportReadyAtom)).toBe(true);

    // A route/socket identity change swaps the runtime's transport identity;
    // the runtime pushes that to the SAME controller through the binding
    // (#1309), and readiness must re-publish after the transient detach
    // (ready=false).
    store.set(terminalTransportReadyAtom, false);
    emitSwap();
    expect(store.get(terminalTransportReadyAtom)).toBe(true);
  });
});
