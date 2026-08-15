// web/src/terminal/controller/__tests__/TerminalController.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TerminalController } from '../TerminalController';
import type { TerminalSession, TerminalStatus } from '../../state/session';
import type { TerminalTransport } from '../../transport/TerminalTransport';

// xterm.open() requires window.matchMedia in jsdom (same stub as TerminalView.test.ts).
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

interface MockTransport extends TerminalTransport {
  send: ReturnType<typeof vi.fn<(data: string) => void>>;
  sendResize: ReturnType<typeof vi.fn<(cols: number, rows: number) => void>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
}

function makeTransport(): MockTransport {
  return {
    mode: 'p2p',
    send: vi.fn<(data: string) => void>(),
    sendResize: vi.fn<(cols: number, rows: number) => void>(),
    onOutput: null,
    onResize: null,
    onStateChange: null,
    onError: null,
    onDisconnect: null,
    dispose: vi.fn<() => void>(),
  };
}

function makeSession(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 'agent1:sess',
    name: 'sess',
    status: 'connected',
    mode: 'p2p',
    startedAt: 1,
    ...overrides,
  };
}

/** Let attach()'s requestAnimationFrame fire and xterm's async write flush. */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 50); });
}

// ── ResizeObserver capture ──────────────────────────────────────────────────

let capturedCallback: ResizeObserverCallback | null = null;
let capturedObserver: ResizeObserver | null = null;
let observedElement: Element | null = null;

class CapturingResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    capturedCallback = callback;
    capturedObserver = this as unknown as ResizeObserver;
  }
  observe(target: Element): void {
    observedElement = target;
  }
  unobserve(_target: Element): void {
    void _target;
  }
  disconnect(): void {}
}

function installCapturingResizeObserver(): () => void {
  const original = globalThis.ResizeObserver;
  capturedCallback = null;
  capturedObserver = null;
  observedElement = null;
  globalThis.ResizeObserver = CapturingResizeObserver;
  return () => {
    globalThis.ResizeObserver = original;
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('TerminalController', () => {
  const hosts: HTMLDivElement[] = [];

  afterEach(() => {
    for (const el of hosts) {
      document.body.removeChild(el);
    }
    hosts.length = 0;
  });

  function host(): HTMLDivElement {
    const el = document.createElement('div');
    document.body.appendChild(el);
    hosts.push(el);
    return el;
  }

  it('stores the session and exposes its id', () => {
    const controller = new TerminalController(makeSession(), () => makeTransport());
    expect(controller.sessionId).toBe('agent1:sess');
    expect(controller.session.name).toBe('sess');
    expect(controller.session.mode).toBe('p2p');
  });

  it('defaults to terminal input mode', () => {
    const controller = new TerminalController(makeSession(), () => makeTransport());
    expect(controller.getInputMode()).toEqual({ type: 'terminal' });
  });

  it('setInputMode/getInputMode round-trip', () => {
    const controller = new TerminalController(makeSession(), () => makeTransport());
    controller.setInputMode({ type: 'search' });
    expect(controller.getInputMode()).toEqual({ type: 'search' });
  });

  it('send delegates to the transport', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    controller.send('hello');

    expect(transport.send).toHaveBeenCalledWith('hello');
  });

  it('routes xterm keyboard input through the input router to the transport', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    controller.terminal!.input('ls -la');

    expect(transport.send).toHaveBeenCalledWith('ls -la');
  });

  it('intercepts Ctrl+D from xterm and routes it to onCtrlD', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    const onCtrlD = vi.fn();
    controller.onCtrlD = onCtrlD;

    controller.terminal!.input('\x04');

    expect(onCtrlD).toHaveBeenCalledTimes(1);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('write writes to the xterm display', () => {
    const controller = new TerminalController(makeSession(), () => makeTransport());
    controller.attach(host());

    const writeSpy = vi.spyOn(controller.terminal!, 'write');
    controller.write('abc');
    expect(writeSpy).toHaveBeenCalledWith('abc');
  });

  it('paste delegates to xterm.paste', () => {
    const controller = new TerminalController(makeSession(), () => makeTransport());
    controller.attach(host());

    const pasteSpy = vi.spyOn(controller.terminal!, 'paste');
    controller.paste('pasted');
    expect(pasteSpy).toHaveBeenCalledWith('pasted');
  });

  it('clear delegates to xterm.clear', () => {
    const controller = new TerminalController(makeSession(), () => makeTransport());
    controller.attach(host());

    const clearSpy = vi.spyOn(controller.terminal!, 'clear');
    controller.clear();
    expect(clearSpy).toHaveBeenCalled();
  });

  it('focus delegates to xterm.focus', () => {
    const controller = new TerminalController(makeSession(), () => makeTransport());
    controller.attach(host());

    const focusSpy = vi.spyOn(controller.terminal!, 'focus');
    controller.focus();
    expect(focusSpy).toHaveBeenCalled();
  });

  it('attach creates xterm, mounts it, and wires transport.onOutput', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    const el = host();

    controller.attach(el);

    expect(controller.terminal).not.toBeNull();
    expect(controller.terminal!.element).toBeDefined();
    expect(el.contains(controller.terminal!.element!)).toBe(true);

    // Output from the transport lands in the xterm display.
    const writeSpy = vi.spyOn(controller.terminal!, 'write');
    transport.onOutput!(new Uint8Array([104, 105]));
    expect(writeSpy).toHaveBeenCalledWith(new Uint8Array([104, 105]));
  });

  it('writes transport output to the terminal in arrival order', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    // Capture writes by spying on the terminal (the agent sends captured
    // scrollback as the FIRST output, so arrival order must be preserved).
    const writeSpy = vi.spyOn(controller.terminal!, 'write');
    transport.onOutput!(new Uint8Array([1]));
    transport.onOutput!(new Uint8Array([2]));

    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(writeSpy).toHaveBeenNthCalledWith(1, new Uint8Array([1]));
    expect(writeSpy).toHaveBeenNthCalledWith(2, new Uint8Array([2]));
    writeSpy.mockRestore();
    controller.detach();
  });

  it('detach disposes xterm, transport, and resize observer', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    controller.detach();

    expect(transport.dispose).toHaveBeenCalled();
    expect(transport.onOutput).toBeNull();
    expect(transport.onStateChange).toBeNull();
    expect(controller.terminal).toBeNull();
  });

  it('resize updates xterm and notifies the transport', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    controller.resize(120, 40);

    expect(transport.sendResize).toHaveBeenCalledWith(120, 40);
    expect(controller.terminal!.cols).toBe(120);
    expect(controller.terminal!.rows).toBe(40);
  });

  it('maps transport remote resize to the xterm grid', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    transport.onResize!(200, 50);

    expect(controller.terminal!.cols).toBe(200);
    expect(controller.terminal!.rows).toBe(50);
  });

  it('maps transport connection state to terminal status', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    const statuses: TerminalStatus[] = [];
    controller.onStateChange = (s) => { statuses.push(s); };

    transport.onStateChange!('connected');
    transport.onStateChange!('disconnected');
    transport.onStateChange!('reconnecting');
    transport.onStateChange!('connecting');

    expect(statuses).toEqual(['connected', 'failed', 'reconnecting', 'connecting']);
  });

  it('wires transport onError and onDisconnect to facade callbacks', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    const onError = vi.fn();
    const onDisconnect = vi.fn();
    controller.onError = onError;
    controller.onDisconnect = onDisconnect;

    const err = new Error('boom');
    transport.onError!(err);
    transport.onDisconnect!();

    expect(onError).toHaveBeenCalledWith(err);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('surfaces xterm title changes via onTitleChange', async () => {
    const controller = new TerminalController(makeSession(), () => makeTransport());
    controller.attach(host());

    const titles: string[] = [];
    controller.onTitleChange = (t) => { titles.push(t); };

    controller.terminal!.write('\x1b]0;My Title\x07');
    await flush();

    expect(titles).toContain('My Title');
  });

  it('resizes immediately on the first ResizeObserver fire', async () => {
    const restore = installCapturingResizeObserver();
    try {
      const transport = makeTransport();
      const controller = new TerminalController(makeSession(), () => transport);
      const el = host();

      controller.attach(el);
      await flush(); // RAF fires → observe() captures the callback

      expect(capturedCallback).not.toBeNull();
      expect(observedElement).toBe(el);

      const entry = { contentRect: { width: 1024, height: 600 } } as unknown as ResizeObserverEntry;
      capturedCallback!([entry], capturedObserver!);

      // 1024/8=128, 600/16=37 (8×16 fallback cell size in jsdom).
      expect(transport.sendResize).toHaveBeenCalledWith(128, 37);
    } finally {
      restore();
    }
  });

  it('debounces subsequent ResizeObserver fires at 200ms', async () => {
    const restore = installCapturingResizeObserver();
    try {
      const transport = makeTransport();
      const controller = new TerminalController(makeSession(), () => transport);
      controller.attach(host());

      await flush(); // RAF fires → observe() captures the callback

      const entryA = { contentRect: { width: 1024, height: 600 } } as unknown as ResizeObserverEntry;
      capturedCallback!([entryA], capturedObserver!);
      expect(transport.sendResize).toHaveBeenCalledTimes(1);

      vi.useFakeTimers();
      const entryB = { contentRect: { width: 800, height: 400 } } as unknown as ResizeObserverEntry;
      capturedCallback!([entryB], capturedObserver!);
      capturedCallback!([entryB], capturedObserver!);
      expect(transport.sendResize).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(200);
      expect(transport.sendResize).toHaveBeenCalledTimes(2);
      expect(transport.sendResize).toHaveBeenLastCalledWith(100, 25);

      vi.useRealTimers();
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it('remeasure recomputes cols/rows from the live cell size after a font-size zoom', async () => {
    const restore = installCapturingResizeObserver();
    try {
      const transport = makeTransport();
      const controller = new TerminalController(makeSession(), () => transport);
      controller.attach(host());

      await flush(); // RAF fires → observe() captures the callback with 8×16 cells

      // Pre-change: container 1024×600 with 8×16 cells → 128×37.
      const entry = { contentRect: { width: 1024, height: 600 } } as unknown as ResizeObserverEntry;
      capturedCallback!([entry], capturedObserver!);
      expect(transport.sendResize).toHaveBeenLastCalledWith(128, 37);

      // Simulate a font-size zoom: the render service now reports larger cells.
      const cell = (controller.terminal! as unknown as {
        _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } };
      })._core._renderService.dimensions.css.cell;
      cell.width = 10;
      cell.height = 20;

      const resizeSpy = vi.spyOn(controller, 'resize');

      // Trigger the post-zoom remeasure — the same path onCellSizeChange wires.
      const rc = (controller as unknown as { resizeController: { remeasure(): void } }).resizeController;
      rc.remeasure();

      // 1024/10=102, 600/20=30 — strictly smaller than the pre-zoom 128×37,
      // proving remeasure read the live cell size, not the stale 8×16 stash.
      expect(resizeSpy).toHaveBeenCalledTimes(1);
      expect(resizeSpy).toHaveBeenCalledWith(102, 30);
    } finally {
      restore();
    }
  });

  it('fontSize zoom triggers a resize recompute through onCellSizeChange', async () => {
    const restore = installCapturingResizeObserver();
    try {
      const transport = makeTransport();
      const controller = new TerminalController(makeSession(), () => transport);
      const el = host();

      controller.attach(el);
      await flush(); // RAF fires → observe() captures the ResizeObserver callback

      // Fire the observer once so ResizeController.lastContainer is live.
      const entry = { contentRect: { width: 1024, height: 600 } } as unknown as ResizeObserverEntry;
      capturedCallback!([entry], capturedObserver!);
      expect(transport.sendResize).toHaveBeenLastCalledWith(128, 37);

      // Clear so the assertions below only see the zoom-triggered resize.
      transport.sendResize.mockClear();

      const resizeSpy = vi.spyOn(controller, 'resize');

      // zoomIn() → FontSizeManager.setSize → term.refresh + onCellSizeChange
      // → resizeController.remeasure() → controller.resize() → sendResize().
      controller.fontSizeManager!.zoomIn();

      expect(resizeSpy).toHaveBeenCalledTimes(1);
      const [cols, rows] = resizeSpy.mock.calls[0] as [number, number];
      expect(cols).toBeGreaterThan(0);
      expect(rows).toBeGreaterThan(0);
      // The recomputed size propagates to the transport (full wiring).
      expect(transport.sendResize).toHaveBeenCalledWith(cols, rows);
      resizeSpy.mockRestore();
    } finally {
      restore();
    }
  });
});
