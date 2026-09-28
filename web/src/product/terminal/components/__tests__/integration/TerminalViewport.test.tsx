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
      paddingBottom: 'var(--terminal-content-bottom-inset, 0px)',
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
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;

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
    globalThis.ResizeObserver = originalResizeObserver;
  });
});
