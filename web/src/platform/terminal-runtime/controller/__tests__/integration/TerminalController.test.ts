// @vitest-environment jsdom
// web/src/terminal/controller/__tests__/TerminalController.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';
import type { TerminalSession } from '@/product/terminal/state/session';
import type { TerminalTransport } from '@/platform/terminal-runtime/transport/TerminalTransport';
import { CapsuleOcclusionScroll } from '@/platform/terminal-runtime/capsule/occlusionScroll';

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
  flushInputBuffer: ReturnType<typeof vi.fn<() => void>>;
  flushPendingResize: ReturnType<typeof vi.fn<() => void>>;
  flushAllOutbound: ReturnType<typeof vi.fn<() => void>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
}

function makeTransport(): MockTransport {
  return {
    mode: 'p2p',
    send: vi.fn<(data: string) => void>(),
    sendResize: vi.fn<(cols: number, rows: number) => void>(),
    flushInputBuffer: vi.fn<() => void>(),
    flushPendingResize: vi.fn<() => void>(),
    flushAllOutbound: vi.fn<() => void>(),
    onOutput: null,
    onResize: null,
    onError: null,
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

  it('forwards Ctrl+D from xterm to the PTY (#1096)', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    controller.terminal!.input('\x04');

    expect(transport.send).toHaveBeenCalledWith('\x04');
  });

  it('sends one keystroke exactly once after a detach and re-attach (#1096)', () => {
    // `detach()` used `setMode({ type: 'terminal' })` to mean "deactivate", but
    // setMode deactivates and then re-activates the handler for the requested
    // mode — and the requested mode is the active one. So it deactivated and
    // immediately re-activated, leaving a live `onData` subscription on a
    // router that was dropped straight after, with nothing left holding a
    // reference to release it. Each keystroke then reached the PTY once per
    // leaked subscription: `x` arrived as `xx`.
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    const el = host();

    controller.attach(el);
    controller.detach();
    controller.attach(el);
    controller.terminal!.input('x');

    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledWith('x');
    controller.dispose();
  });

  it('sends one keystroke exactly once after five attach/detach cycles (#1096)', () => {
    // The leak is cumulative, not capped at 2x.
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    const el = host();

    for (let cycle = 0; cycle < 5; cycle += 1) {
      controller.attach(el);
      controller.detach();
    }
    controller.attach(el);
    controller.terminal!.input('x');

    expect(transport.send).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('sends one keystroke exactly once after a viewport reparent (#1096)', () => {
    // The reparent branch tore down a different subset than `detach()` — the
    // transport and the capsule scroll, but not the input handler, the IME,
    // the resize observer or the title subscription. A React remount therefore
    // leaked a subscription the next wiring doubled.
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);

    controller.attach(host());
    controller.attach(host());
    controller.terminal!.input('x');

    expect(transport.send).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('forwards toolbar Ctrl+D (send("\\x04")) to the PTY (#1096)', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    controller.send('\x04');

    expect(transport.send).toHaveBeenCalledWith('\x04');
  });

  it('flushInputBuffer delegates to the transport', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    controller.flushInputBuffer();

    expect(transport.flushInputBuffer).toHaveBeenCalledTimes(1);
  });

  it('flushAllOutbound delegates to the transport', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    controller.flushAllOutbound();

    expect(transport.flushAllOutbound).toHaveBeenCalledTimes(1);
  });

  it('write writes to the xterm display', () => {
    const controller = new TerminalController(makeSession(), () => makeTransport());
    controller.attach(host());

    const writeSpy = vi.spyOn(controller.terminal!, 'write');
    controller.write('abc');
    expect(writeSpy).toHaveBeenCalledWith('abc', expect.any(Function));
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
    expect(writeSpy).toHaveBeenCalledWith(new Uint8Array([104, 105]), expect.any(Function));
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
    expect(writeSpy).toHaveBeenNthCalledWith(1, new Uint8Array([1]), expect.any(Function));
    expect(writeSpy).toHaveBeenNthCalledWith(2, new Uint8Array([2]), expect.any(Function));
    writeSpy.mockRestore();
    controller.detach();
  });

  it('wipes the buffer before a bootstrap, and only its own modes survive', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    const writeSpy = vi.spyOn(controller.terminal!, 'write');
    const resetSpy = vi.spyOn(controller.terminal!, 'reset');
    transport.onOutput!(new Uint8Array([104, 105]), { requestedLines: 5000, truncated: false });

    // Erase display, erase scrollback, cursor home — in that order, before the
    // snapshot itself, so the history it carries is all the buffer holds.
    expect(writeSpy).toHaveBeenNthCalledWith(1, '\x1b[2J\x1b[3J\x1b[H');
    expect(writeSpy).toHaveBeenNthCalledWith(2, new Uint8Array([104, 105]), expect.any(Function));
    // `reset()` would leave the alternate screen and clear modes the
    // application set — a TUI's pane would come back normal-buffered.
    expect(resetSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
    resetSpy.mockRestore();
    controller.detach();
  });

  it('keeps the scrollback when the snapshot the agent sent was cut short (#1305)', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    const writeSpy = vi.spyOn(controller.terminal!, 'write');
    transport.onOutput!(new Uint8Array([104, 105]), { requestedLines: 5000, truncated: true });

    // Erase the display and home the cursor, but leave the scrollback: the
    // agent's ceiling drops the *oldest* history, and this client holds up to
    // 50k lines against a 512 KiB capture — so the snapshot cannot stand in
    // for what `\x1b[3J` would have destroyed. The screen it *can* restore is
    // still replaced, which is why the display wipe stays.
    expect(writeSpy).toHaveBeenNthCalledWith(1, '\x1b[2J\x1b[H');
    expect(writeSpy).toHaveBeenNthCalledWith(2, new Uint8Array([104, 105]), expect.any(Function));
    writeSpy.mockRestore();
    controller.detach();
  });

  it('appends, without wiping, when the frame carries no marker', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    const writeSpy = vi.spyOn(controller.terminal!, 'write');
    transport.onOutput!(new Uint8Array([1]));
    transport.onOutput!(new Uint8Array([2]), undefined);

    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(writeSpy).toHaveBeenNthCalledWith(1, new Uint8Array([1]), expect.any(Function));
    expect(writeSpy).toHaveBeenNthCalledWith(2, new Uint8Array([2]), expect.any(Function));
    writeSpy.mockRestore();
    controller.detach();
  });

  it('reports hasSessionOutput only once output has arrived, bootstrap included', async () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    // A freshly attached controller is what a page reload produces, and it is
    // the case a bootstrap exists for.
    expect(controller.hasSessionOutput).toBe(false);

    // A local write is display, not the session's history — it must not stop
    // the attach from asking for one.
    controller.write('local banner');
    expect(controller.hasSessionOutput).toBe(false);

    // A snapshot is handed over, not held: the flag answers "does my Terminal
    // hold the session's history", and xterm has not parsed this yet (#1491).
    // Lifting it here is how an attach that arrives mid-parse decides it needs
    // no snapshot — over a buffer that is still empty.
    transport.onOutput!(new Uint8Array([104, 105]), { requestedLines: 5000, truncated: false });
    expect(controller.hasSessionOutput).toBe(false);

    await flush();
    expect(controller.hasSessionOutput).toBe(true);
    controller.detach();
  });

  it('latches hasSessionOutput on arrival for live output, which has no completion (#1491)', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    // No bootstrap marker: this is the session's stream. Waiting for a write
    // callback here would report "no session output" for as long as the
    // callback takes — and there is nothing for it to prove.
    transport.onOutput!(new Uint8Array([104, 105]));
    expect(controller.hasSessionOutput).toBe(true);
    controller.detach();
  });

  it('ignores a superseded snapshot when it finally lands (#1491)', async () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    // Two snapshots in flight — a re-attach arriving while the first is still
    // parsing, which is what a large history plus a rewire produces. The first
    // callback describes a buffer the second one has since erased, so it must
    // not lift the flag; only the newest snapshot speaks for the buffer.
    const writes: Array<() => void> = [];
    const writeSpy = vi.spyOn(controller.terminal!, 'write').mockImplementation(
      ((_data: unknown, callback?: () => void) => { if (callback) { writes.push(callback); } }) as never,
    );

    transport.onOutput!(new Uint8Array([49]), { requestedLines: 5000, truncated: false });
    transport.onOutput!(new Uint8Array([50]), { requestedLines: 5000, truncated: false });
    expect(writes).toHaveLength(2);

    writes[0]!();  // the superseded snapshot lands
    expect(controller.hasSessionOutput).toBe(false);

    writes[1]!();  // the one the buffer actually holds
    expect(controller.hasSessionOutput).toBe(true);

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

  it('resizeLocal updates xterm without notifying the transport', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    controller.resizeLocal(120, 40);

    expect(controller.terminal!.cols).toBe(120);
    expect(controller.terminal!.rows).toBe(40);
    expect(transport.sendResize).not.toHaveBeenCalled();
  });

  it('sendResize notifies the transport without touching the xterm grid', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());
    const before = { cols: controller.terminal!.cols, rows: controller.terminal!.rows };

    controller.sendResize(120, 40);

    expect(transport.sendResize).toHaveBeenCalledWith(120, 40);
    expect(controller.terminal!.cols).toBe(before.cols);
    expect(controller.terminal!.rows).toBe(before.rows);
  });

  it('maps transport remote resize to the xterm grid', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    transport.onResize!(200, 50);

    expect(controller.terminal!.cols).toBe(200);
    expect(controller.terminal!.rows).toBe(50);
  });

  it('wires transport onError to the facade callback', () => {
    const transport = makeTransport();
    const controller = new TerminalController(makeSession(), () => transport);
    controller.attach(host());

    const onError = vi.fn();
    controller.onError = onError;

    const err = new Error('boom');
    transport.onError!(err);

    expect(onError).toHaveBeenCalledWith(err);
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

  it('holds the first PTY size back until the cell box is final, then sends it once (#1490)', async () => {
    // The defect: xterm measures one cell at open() and caches it, so a grid
    // computed before the webfont lands is the *fallback's*. That grid was
    // published and sent, and the font-load correction then sent a second
    // size — two real resizes of the shared tmux window per page reload, each
    // repainting an inline-drawing application into its scrollback. The local
    // grid keeps following the container in the first frame; only the half
    // that leaves the client waits.
    const restore = installCapturingResizeObserver();
    const hadFonts = Object.prototype.hasOwnProperty.call(document, 'fonts');
    const fontsStub = {
      status: 'loading' as FontFaceSet['status'],
      ready: Promise.resolve(),
      // TerminalInstance warms the terminal face at construction; the stub
      // only has to not throw there.
      load: () => Promise.resolve([]),
    };
    let resolveReady: () => void = () => {};
    fontsStub.ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    Object.defineProperty(document, 'fonts', { configurable: true, value: fontsStub });
    try {
      const transport = makeTransport();
      const controller = new TerminalController(makeSession(), () => transport);
      controller.attach(host());
      await flush(); // RAF fires → observe() captures the callback

      const entry = { contentRect: { width: 1024, height: 600 } } as unknown as ResizeObserverEntry;
      capturedCallback!([entry], capturedObserver!);

      // The local grid follows at once, from the cell box xterm has now
      // (8×16 fallback cells in jsdom): 1024/8=128, 600/16=37.
      expect(controller.terminal!.cols).toBe(128);
      expect(controller.terminal!.rows).toBe(37);
      // Nothing left the client — this grid is a size the pane never had.
      expect(transport.sendResize).not.toHaveBeenCalled();

      // The webfont lands: `TerminalInstance`'s font-load correction reports
      // the grid through onCellSizeChange → remeasure.
      fontsStub.status = 'loaded';
      resolveReady();
      await flush();

      // Exactly one size left the client, and it is the one recomputed at
      // settle time. The numbers match the pre-font grid here only because
      // jsdom has no real font metrics; that the *recomputed* size wins over
      // the `grid` this fire captured is what the browser measurement shows
      // (one SIGWINCH per reload instead of two — #1490).
      expect(transport.sendResize).toHaveBeenCalledTimes(1);
      expect(transport.sendResize).toHaveBeenCalledWith(128, 37);
      controller.dispose();
    } finally {
      if (!hadFonts) { delete (document as { fonts?: unknown }).fonts; }
      restore();
    }
  });

  it('sizes the grid and the session to the well minus the capsule band, in both modes (#1503)', async () => {
    // The well applies the capsule's clearance as `padding-bottom` on the
    // element this controller observes, and `contentRect` excludes padding — so
    // the scroll mode used to *be* the grid size, and every entry into history
    // moved the shared tmux window (measured: 32 ↔ 35 rows, 60 px ÷ 20 px
    // cells) and made an inline TUI repaint into the history being read.
    const restore = installCapturingResizeObserver();
    try {
      const transport = makeTransport();
      const controller = new TerminalController(makeSession(), () => transport);
      const el = host();
      controller.attach(el);
      await flush(); // RAF fires → observe() captures the callback

      // Following: the capsule's band (60 px — 3 rows at these 16 px cells) is
      // reserved as padding, so the content box is 60 px shorter. The band's
      // own size is the variable the padding derives from, which is what lets
      // the two modes agree.
      el.style.setProperty('--nession-local-terminal-capsule-occlusion', '60px');
      el.style.paddingBottom = '60px';
      const withBand = { contentRect: { width: 1024, height: 540 } } as unknown as ResizeObserverEntry;
      capturedCallback!([withBand], capturedObserver!);

      // The grid — and the session — take the well *minus* the band: 600/16
      // rows. Sizing to the well instead would draw rows the padding clips.
      expect(controller.terminal!.rows).toBe(33);
      expect(transport.sendResize).toHaveBeenLastCalledWith(128, 33);

      vi.useFakeTimers();
      // History: the band is released, the content box grows by the same 60 px.
      el.style.paddingBottom = '0px';
      const released = { contentRect: { width: 1024, height: 600 } } as unknown as ResizeObserverEntry;
      capturedCallback!([released], capturedObserver!);
      // The grid does not grow into the freed band — the band comes off in both
      // modes, so the size the user types at is the size they keep.
      expect(controller.terminal!.rows).toBe(33);
      vi.advanceTimersByTime(200);

      // The invariant: the reported size never moved. Every size this client
      // sent is the same one — the local grid changing is drawing, and the
      // session was never told about it.
      const sent = (transport.sendResize.mock.calls as Array<[number, number]>)
        .map(([cols, rows]) => `${cols}x${rows}`);
      expect([...new Set(sent)]).toEqual(['128x33']);
      vi.useRealTimers();
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it('installs local capsule scrolling only for the local-buffer policy', async () => {
    const restore = installCapturingResizeObserver();
    const bindSpy = vi.spyOn(CapsuleOcclusionScroll.prototype, 'bind');
    try {
      const shell = host();
      shell.setAttribute('data-terminal-capsule-host', '');
      const legacyViewport = document.createElement('div');
      shell.appendChild(legacyViewport);
      const legacy = new TerminalController(makeSession(), () => makeTransport());
      legacy.attach(legacyViewport);
      await flush();
      expect(bindSpy).not.toHaveBeenCalled();
      legacy.dispose();

      bindSpy.mockClear();
      const localShell = host();
      localShell.setAttribute('data-terminal-capsule-host', '');
      const localViewport = document.createElement('div');
      localShell.appendChild(localViewport);
      const local = new TerminalController(
        makeSession(),
        () => makeTransport(),
        { rendererType: 'canvas', scrollbackMode: 'local-buffer' },
      );
      const wheelHandlerSpy = vi.spyOn(local.terminal!, 'attachCustomWheelEventHandler');
      local.attach(localViewport);
      await flush();
      expect(bindSpy).toHaveBeenCalledTimes(1);
      expect(wheelHandlerSpy).toHaveBeenCalled();
      local.dispose();
    } finally {
      bindSpy.mockRestore();
      restore();
    }
  });

  it('keeps the xterm browser-buffer position while output arrives in history', async () => {
    const restore = installCapturingResizeObserver();
    try {
      const shell = host();
      shell.setAttribute('data-terminal-capsule-host', '');
      shell.setAttribute('data-terminal-scrollback-mode', 'local-buffer');
      const viewport = document.createElement('div');
      shell.appendChild(viewport);
      const controller = new TerminalController(
        makeSession(),
        () => makeTransport(),
        { rendererType: 'canvas', scrollbackMode: 'local-buffer' },
      );
      controller.attach(viewport);
      await flush();

      controller.write(Array.from({ length: 80 }, (_, i) => `line-${i}`).join('\r\n'));
      await flush();

      const terminal = controller.terminal!;
      const bottom = terminal.buffer.active.viewportY;
      const event = new WheelEvent('wheel', { deltaY: -80, cancelable: true });
      terminal.element!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(terminal.buffer.active.viewportY).toBeLessThan(bottom);

      const scrollToBottom = vi.spyOn(terminal, 'scrollToBottom');
      controller.write('\r\nnew-output');
      await flush();

      expect(scrollToBottom).not.toHaveBeenCalled();
      expect(terminal.buffer.active.viewportY).toBeLessThan(terminal.buffer.active.length - terminal.rows);
      controller.dispose();
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

  it('applies the local xterm grid synchronously on a debounced resize', async () => {
    // Regression: the debounce used to hold BOTH halves of the resize, so for
    // 200ms xterm kept painting at the previous container's pixel size. On
    // mobile the input panel opens with no animation, so that gap showed up as
    // a flash of bare container background (grow) or clipped overflow (shrink).
    const restore = installCapturingResizeObserver();
    try {
      const transport = makeTransport();
      const controller = new TerminalController(makeSession(), () => transport);
      controller.attach(host());

      await flush(); // RAF fires → observe() captures the callback

      // First fire is immediate on both halves (8×16 fallback cells in jsdom).
      const entryA = { contentRect: { width: 1024, height: 600 } } as unknown as ResizeObserverEntry;
      capturedCallback!([entryA], capturedObserver!);
      expect(controller.terminal!.cols).toBe(128);
      expect(controller.terminal!.rows).toBe(37);

      vi.useFakeTimers();
      // Container shrinks (input panel opened). xterm must follow in the same
      // tick — no timer advance — or the two disagree on screen.
      const entryB = { contentRect: { width: 800, height: 400 } } as unknown as ResizeObserverEntry;
      capturedCallback!([entryB], capturedObserver!);
      expect(controller.terminal!.cols).toBe(100);
      expect(controller.terminal!.rows).toBe(25);
      // ...while tmux is still waiting on the debounce.
      expect(transport.sendResize).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(200);
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

      // Trigger the post-zoom remeasure — the same path onCellSizeChange wires.
      const rc = (controller as unknown as { resizeController: { remeasure(): void } }).resizeController;
      rc.remeasure();

      // 1024/10=102, 600/20=30 — strictly smaller than the pre-zoom 128×37,
      // proving remeasure read the live cell size, not the stale 8×16 stash.
      //
      // Asserted as two facts rather than one spied call: the local grid
      // follows the cell box and the *reported* size follows it minus the
      // container's own inset (`reportedGrid`). They coincide here only
      // because jsdom computes no padding.
      expect(controller.terminal!.cols).toBe(102);
      expect(controller.terminal!.rows).toBe(30);
      expect(transport.sendResize).toHaveBeenLastCalledWith(102, 30);
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

      // zoomIn() → FontSizeManager.setSize → term.refresh + onCellSizeChange
      // → resizeController.remeasure() → local grid + reported size.
      controller.fontSizeManager!.zoomIn();

      // The full wiring, read from what the transport received rather than
      // from an internal call: the recomputed size reaches the transport, and
      // the local grid agrees with it (no capsule inset in jsdom).
      expect(transport.sendResize).toHaveBeenCalledTimes(1);
      const [cols, rows] = transport.sendResize.mock.calls[0] as [number, number];
      expect(cols).toBeGreaterThan(0);
      expect(rows).toBeGreaterThan(0);
      expect(controller.terminal!.cols).toBe(cols);
      expect(controller.terminal!.rows).toBe(rows);
    } finally {
      restore();
    }
  });
});
