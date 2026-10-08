import { StrictMode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TerminalViewport } from '@/product/terminal/components/TerminalViewport';
import { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';
import type { TerminalSession } from '@/product/terminal/state/session';
import type { TerminalTransport } from '@/platform/terminal-runtime/transport/TerminalTransport';

function makeController(): TerminalController {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as TerminalController;
}

// xterm.open() requires window.matchMedia in jsdom; ResizeObserver likewise,
// since the controller wires one as part of attaching.
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

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function makeTransport() {
  return {
    mode: 'p2p',
    send: vi.fn(),
    sendResize: vi.fn(),
    flushInputBuffer: vi.fn(),
    flushPendingResize: vi.fn(),
    flushAllOutbound: vi.fn(),
    onOutput: null,
    onResize: null,
    onStateChange: null,
    onError: null,
    onDisconnect: null,
    dispose: vi.fn(),
  } as unknown as TerminalTransport & { send: ReturnType<typeof vi.fn> };
}

function makeSession(): TerminalSession {
  return {
    id: 'agent1:sess',
    name: 'sess',
    status: 'connected',
    mode: 'p2p',
    startedAt: 1,
  };
}

/** Let the attach's requestAnimationFrame fire and xterm's async write flush. */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 50); });
}

/**
 * Run `body` with a ResizeObserver stub installed.
 *
 * xterm's `open()` needs one in jsdom and the global setup does not provide it,
 * so the tests that build a real controller install their own. Restoring it in
 * a `finally` rather than after the assertions is the point: a failing test
 * would otherwise leave the stub in place for everything that runs after it in
 * this file, turning one red test into several confusing ones.
 */
async function withResizeObserverStub(body: () => Promise<void>): Promise<void> {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
  try {
    await body();
  } finally {
    globalThis.ResizeObserver = original;
  }
}

describe('TerminalViewport', () => {
  it('renders a div with the terminal background colour', () => {
    const controller = makeController();
    const { container } = render(<TerminalViewport controller={controller} />);

    const el = container.firstElementChild;
    expect(el).not.toBeNull();
    expect(el).toHaveClass('h-full', 'w-full', 'bg-terminal-background');
  });

  it('reserves the capsule occlusion inside the xterm viewport', () => {
    const controller = makeController();
    const { container } = render(<TerminalViewport controller={controller} />);

    expect(container.firstElementChild).toHaveStyle({
      paddingBottom: 'var(--nession-local-terminal-content-bottom-inset, 0px)',
    });
  });

  it('calls controller.attach on mount and detach on unmount', () => {
    const controller = makeController();
    const { unmount } = render(<TerminalViewport controller={controller} />);

    expect(controller.attach).toHaveBeenCalledTimes(1);

    unmount();
    expect(controller.detach).toHaveBeenCalledTimes(1);
  });

  it('sends one typed keystroke exactly once under StrictMode (#1096)', async () => {
    // The criterion asks for the React path, not the controller's alone, and it
    // is the right level: StrictMode's mount → cleanup → mount is exactly
    // attach → detach → attach on one controller, which is the cycle the leak
    // lived in. `detach()` used to re-activate the handler it meant to
    // deactivate, so the second attach left two live `onData` subscriptions and
    // a single typed `x` reached the PTY twice. The controller here is real —
    // mocking it would assert that attach was called, which is not the property.
    await withResizeObserverStub(async () => {
      const transport = makeTransport();
      const controller = new TerminalController(makeSession(), () => transport);

      render(
        <StrictMode>
          <TerminalViewport controller={controller} />
        </StrictMode>,
      );
      await flush();

      const terminal = controller.terminal;
      expect(terminal).not.toBeNull();
      terminal!.input('x');

      expect(transport.send).toHaveBeenCalledTimes(1);
      expect(transport.send).toHaveBeenCalledWith('x');

      controller.dispose();
    });
  });

  it('sends one typed keystroke exactly once after a transport-swap rewire (#1096)', async () => {
    // The production path #668 was about. A P2P route or socket identity change
    // swaps the runtime's transport identity, and the runtime pushes that to
    // the controller through the binding subscription — the controller
    // detaches and re-attaches itself in the same tick, with no React render
    // involved (#1309). CI never caught the duplication here: `terminal-io`
    // attaches once, and its own comment blames this exact window for stray
    // bytes ("P2P attach can rewire the transport once the live agent-terminal
    // API swaps (#668)") rather than asserting on it.
    //
    // Readiness across the swap is asserted in
    // `useTerminalViewportTransportReady.test.tsx`. What is asserted here is
    // what a user would see: one key, one send.
    await withResizeObserverStub(async () => {
      const transport = makeTransport();
      let transports = 0;
      let swapListener: (() => void) | null = null;
      const controller = new TerminalController(
        makeSession(),
        () => {
          transports += 1;
          return transport;
        },
        {
          rendererType: 'canvas',
          transportBinding: {
            subscribe: (listener) => {
              swapListener = listener;
              return () => {};
            },
          },
        },
      );

      render(<TerminalViewport controller={controller} />);
      await flush();

      swapListener!();
      await flush();

      // The rewire is the thing under test, so assert it happened: a swap that
      // detached nothing would leave the counts below just as green.
      expect(transports).toBe(2);

      const terminal = controller.terminal;
      expect(terminal).not.toBeNull();
      transport.send.mockClear();
      terminal!.input('x');

      expect(transport.send).toHaveBeenCalledTimes(1);
      expect(transport.send).toHaveBeenCalledWith('x');

      controller.dispose();
    });
  });
});
