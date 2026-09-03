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
import { useTerminal } from '@/terminal/hooks/useTerminal';
import { TerminalViewport } from '@/terminal/components/TerminalViewport';
import { terminalTransportReadyAtom } from '@/terminal/state/transport';
import type { TerminalTransport } from '@/terminal/transport/TerminalTransport';

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

// Module-stable factory — a new identity per render would recreate the
// controller every render (transportFactory is a useTerminal memo dep).
function transportFactory(): TerminalTransport {
  return makeTransport();
}

function Harness({ sessionId, epoch = 0 }: { sessionId: string; epoch?: number }) {
  const controller = useTerminal({
    sessionId,
    sessionName: 'sess',
    mode: 'relay',
    transportFactory,
    rendererType: 'canvas',
  });
  return <TerminalViewport controller={controller} transportEpoch={epoch} />;
}

describe('useTerminal + TerminalViewport transport readiness', () => {
  afterEach(() => {
    cleanup();
  });

  it('publishes transportReady=true when the viewport attaches on first mount', () => {
    const store = getDefaultStore();
    store.set(terminalTransportReadyAtom, false);

    render(<Harness sessionId="agent1:sess" />);

    // The layout-phase attach must reach the atom even though no passive
    // effect has run yet (issue #598 — the event used to be lost here).
    expect(store.get(terminalTransportReadyAtom)).toBe(true);
  });

  it('republishes readiness across a transportEpoch bump (same controller)', () => {
    const store = getDefaultStore();
    store.set(terminalTransportReadyAtom, false);

    const { rerender } = render(<Harness sessionId="agent1:sess" />);
    expect(store.get(terminalTransportReadyAtom)).toBe(true);

    // transportKey changes (route/socket identity) remount the viewport via the
    // TerminalViewport layout effect with the SAME controller; readiness must
    // re-publish after the transient detach (ready=false).
    rerender(<Harness sessionId="agent1:sess" epoch={1} />);
    expect(store.get(terminalTransportReadyAtom)).toBe(true);
  });
});
