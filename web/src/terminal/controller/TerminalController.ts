// web/src/terminal/controller/TerminalController.ts
import { Terminal } from '@xterm/xterm';
import { getDefaultStore } from 'jotai';
import type { ConnectionState } from '../../hooks/useP2PConnection';
import { inputModeAtomFamily, type InputMode } from '../state/input';
import { lastResizeAtom } from '../state/terminal';
import type { TerminalSession, TerminalStatus } from '../state/session';
import type { TerminalTransport } from '../transport/TerminalTransport';
import { InputRouter } from '../input/InputRouter';
import { InputSourceManager } from '../input/InputSourceManager';
import { TerminalInputHandler } from '../input/TerminalInputHandler';
import { CommandInputHandler } from '../input/CommandInputHandler';
import { SearchInputHandler } from '../input/SearchInputHandler';
import { AIInputHandler } from '../input/AIInputHandler';
import { CustomInputHandler } from '../input/CustomInputHandler';
import { CapsuleOcclusionScroll } from '../capsule/occlusionScroll';
import { TerminalInstance } from '../instance/TerminalInstance';
import { MobileImeInput } from '../input/MobileImeInput';
import type { FontSizeManager } from '../FontSizeManager';
import type { DeviceProfile } from '../types';

export interface TerminalControllerOptions {
  rendererType: 'webgl' | 'canvas';
  fontSize?: number;
  scrollback?: number;
  /**
   * Device class this terminal was built for. 'mobile' swaps xterm's hidden
   * helper textarea for {@link MobileImeInput} so soft keyboards and IMEs have
   * a real, cursor-anchored element to attach to.
   */
  deviceProfile?: DeviceProfile;
}

/**
 * Mobile IME handling needs both a mobile-sized viewport and actual touch
 * input. A touch-capable laptop stays on the desktop path: MobileImeInput
 * deliberately does not translate Ctrl/Alt chords, which a physical keyboard
 * needs and xterm already handles.
 */
function shouldUseMobileIme(profile: DeviceProfile | undefined): boolean {
  return profile === 'mobile' && typeof window !== 'undefined' && 'ontouchstart' in window;
}

/** Map a transport ConnectionState onto the domain TerminalStatus. */
function mapConnectionState(state: ConnectionState): TerminalStatus {
  switch (state) {
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'disconnected':
      return 'failed';
    case 'reconnecting':
      return 'reconnecting';
  }
}

/**
 * Imperative facade over xterm + TerminalTransport. React components interact
 * with this class instead of touching xterm or WebSocket/P2P details directly.
 *
 * The transport is acquired lazily via a factory (not a direct instance) so
 * the controller never couples to ConnectionManager's concrete shape — the
 * caller wraps ConnectionManager into a TerminalTransport at the boundary.
 */
export class TerminalController {
  readonly session: TerminalSession;

  private _terminal: Terminal | null = null;
  private instance: TerminalInstance;
  private transportFactory: () => TerminalTransport;
  private transport: TerminalTransport | null = null;
  private resizeController: ResizeController | null = null;
  private inputRouter: InputRouter | null = null;
  private inputSourceManager: InputSourceManager;
  private mobileIme: MobileImeInput | null = null;
  private capsuleOcclusionScroll: CapsuleOcclusionScroll | null = null;
  private useMobileIme: boolean;
  private attached = false;

  /** Callbacks → Jotai */
  onStateChange: ((status: TerminalStatus) => void) | null = null;
  onTitleChange: ((title: string) => void) | null = null;
  onCtrlD: (() => void) | null = null;
  onError: ((err: Error) => void) | null = null;
  onDisconnect: (() => void) | null = null;

  constructor(
    session: TerminalSession,
    transportFactory: () => TerminalTransport,
    options: TerminalControllerOptions = { rendererType: 'canvas' },
  ) {
    this.session = session;
    this.transportFactory = transportFactory;
    this.instance = new TerminalInstance(options);
    this._terminal = this.instance.terminal;
    this.inputSourceManager = new InputSourceManager();
    this.useMobileIme = shouldUseMobileIme(options.deviceProfile);
    this.initInputRouter();
  }

  /**
   * Create the input router and register the mode handlers that don't need an
   * xterm instance yet. The terminal handler is registered in attach() once the
   * xterm instance exists. Returns the router so re-attach can rebuild it after
   * detach() clears the reference.
   */
  private initInputRouter(): InputRouter {
    const router = new InputRouter();
    router.register(new CommandInputHandler());
    router.register(new SearchInputHandler());
    router.register(new AIInputHandler());
    router.register(new CustomInputHandler());
    this.inputRouter = router;
    return router;
  }

  /** xterm instance while attached; null after detach(). */
  get terminal(): Terminal | null {
    return this._terminal;
  }

  get sessionId(): string {
    return this.session.id;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Create xterm, mount on `element`, and wire the transport to it. */
  attach(element: HTMLElement): void {
    if (this.attached) { return; }

    const transport = this.transportFactory();
    this.instance.onCellSizeChange = () => {
      this.resizeController?.remeasure();
    };
    const terminal = this.instance.terminal;

    this.transport = transport;
    this._terminal = terminal;
    this.attached = true;

    this.instance.attach(element);

    const capsuleHost = element.closest('[data-terminal-capsule-host]');
    if (capsuleHost instanceof HTMLElement) {
      this.capsuleOcclusionScroll = new CapsuleOcclusionScroll(
        terminal,
        capsuleHost,
        () => this.cellDimensions.height,
      );
      this.capsuleOcclusionScroll.bind();
    }

    // Transport → xterm: display output as it arrives.
    transport.onOutput = (data: Uint8Array) => {
      const follow = this.capsuleOcclusionScroll?.snapshotFollowing() ?? false;
      terminal.write(data);
      if (follow) {
        this.capsuleOcclusionScroll?.afterOutputWhileFollowing();
      }
    };
    // Remote (tmux → agent) resize → local xterm grid.
    transport.onResize = (cols: number, rows: number) => { terminal.resize(cols, rows); };
    // Transport connection state → domain TerminalStatus callback.
    transport.onStateChange = (state: ConnectionState) => {
      this.onStateChange?.(mapConnectionState(state));
    };
    // Transport failure / disconnect → facade callbacks.
    transport.onError = (err: Error) => { this.onError?.(err); };
    transport.onDisconnect = () => { this.onDisconnect?.(); };

    terminal.onTitleChange((title: string) => { this.onTitleChange?.(title); });

    // Input routing: terminal mode is the default, so register + activate the
    // terminal handler now. Keyboard input flows xterm → handler → transport.
    const router = this.inputRouter ?? this.initInputRouter();
    const terminalHandler = new TerminalInputHandler(
      transport,
      (cb) => {
        const disposable = terminal.onData(cb);
        return () => disposable.dispose();
      },
    );
    terminalHandler.onCtrlD = () => this.onCtrlD?.();
    router.register(terminalHandler);
    terminalHandler.activate();

    // Mobile: give the soft keyboard / IME a real cursor-anchored textarea.
    // Must come after instance.attach() — it reaches into terminal.element.
    if (this.useMobileIme && terminal.element) {
      this.mobileIme = new MobileImeInput(terminal, terminal.element, {
        onSend: (text) => {
          this.handleInput({ source: 'touch', data: text, timestamp: Date.now() });
        },
      });
    }

    // Observe the container after first render so it has laid out.
    this.resizeController = new ResizeController(this);
    requestAnimationFrame(() => {
      if (!this.attached) { return; }
      const dims = this.cellDimensions;
      this.resizeController?.observe(element, dims.width, dims.height);
    });
  }

  /** Dispose xterm, transport, and the resize observer. */
  detach(): void {
    if (!this.attached) { return; }
    this.attached = false;

    this.resizeController?.dispose();
    this.resizeController = null;

    this.mobileIme?.dispose();
    this.mobileIme = null;

    this.capsuleOcclusionScroll?.dispose();
    this.capsuleOcclusionScroll = null;

    // Break transport→terminal closures before disposing either side.
    if (this.transport) {
      this.transport.onOutput = null;
      this.transport.onResize = null;
      this.transport.onStateChange = null;
      this.transport.onError = null;
      this.transport.onDisconnect = null;
    }

    // Deactivate the active input handler (unsubscribes xterm onData) and drop
    // the router so the terminal handler's closures are released before dispose.
    this.inputRouter?.setMode({ type: 'terminal' });
    this.inputRouter = null;

    this.instance.detach();
    this._terminal = null;

    this.transport?.dispose();
    this.transport = null;
  }

  // ── Data flow ───────────────────────────────────────────────────────────

  /** Write data to the xterm display (e.g. from an external source). */
  write(data: string | Uint8Array): void {
    const follow = this.capsuleOcclusionScroll?.snapshotFollowing() ?? false;
    this._terminal?.write(data);
    if (follow) {
      this.capsuleOcclusionScroll?.afterOutputWhileFollowing();
    }
  }

  /**
   * Unified input entry point for all input sources.
   * Layer 1: Update active source via InputSourceManager
   * Layer 2: Route to current mode handler via InputRouter
   */
  handleInput(event: import('../types').InputEvent): void {
    // Layer 1: Update active source
    this.inputSourceManager.setActiveSource(event.source);

    // Layer 2: Route to current mode handler
    this.inputRouter?.route(event.data);
  }

  /** Send user input to the transport (→ PTY). */
  send(data: string, source: import('../types').InputSource = 'component-input'): void {
    // Toolbar quick-command Ctrl+D ("\x04") routes to the disconnect flow, the
    // same as keyboard Ctrl+D (handled by TerminalInputHandler → onCtrlD).
    if (data === '\x04') { this.onCtrlD?.(); return; }
    this.handleInput({ source, data, timestamp: Date.now() });
  }

  /** Get the currently active input source. */
  getActiveInputSource(): import('../types').InputSource | null {
    return this.inputSourceManager.getActiveSource();
  }

  /**
   * Register a callback for input source changes.
   * Returns an unsubscribe function.
   */
  onInputSourceChange(callback: (source: import('../types').InputSource) => void): () => void {
    return this.inputSourceManager.onSourceChange(callback);
  }

  /** Flush any input buffered before the transport was attached. */
  flushInputBuffer(): void {
    this.transport?.flushInputBuffer();
  }

  /**
   * Flush every outbound buffer (input FIFO + coalesced resize) in one call.
   * Wired to the terminalState === 'attached' transition so queued I/O leaves
   * the browser as soon as the agent has acked client.attach.
   */
  flushAllOutbound(): void {
    this.transport?.flushAllOutbound();
  }

  // ── Terminal actions ────────────────────────────────────────────────────

  /** Resize the local xterm grid optimistically and notify the transport. */
  resize(cols: number, rows: number): void {
    this.resizeLocal(cols, rows);
    this.sendResize(cols, rows);
  }

  /**
   * Resize only the local xterm grid, without touching the transport.
   *
   * Split out from resize() because the two halves want opposite timing: the
   * local grid must follow a container size change in the SAME frame (otherwise
   * xterm keeps painting at the old pixel size and the mismatch is visible as a
   * flicker), while the PTY notification must be debounced so a drag doesn't
   * flood tmux. See ResizeController.
   */
  resizeLocal(cols: number, rows: number): void {
    this._terminal?.resize(cols, rows);
  }

  /** Notify the transport (→ PTY) of a new size, without touching xterm. */
  sendResize(cols: number, rows: number): void {
    this.transport?.sendResize(cols, rows);
  }

  focus(): void {
    // On mobile the IME textarea is the real input target; focusing xterm would
    // only bounce through the helper-textarea redirect.
    if (this.mobileIme) {
      this.mobileIme.focus();
      return;
    }
    this._terminal?.focus();
  }

  clear(): void {
    this._terminal?.clear();
  }

  paste(text: string): void {
    this._terminal?.paste(text);
  }

  // ── Scroll / font-size / cell dimensions ─────────────────────────────────

  /** Scroll the xterm viewport to the live bottom (above capsule occlusion when present). */
  scrollToBottom(): void {
    if (this.capsuleOcclusionScroll) {
      this.capsuleOcclusionScroll.scrollToMarginBottom();
      return;
    }
    this.instance.scrollToBottom();
  }
  /** Scroll the xterm viewport by whole pages (negative = up). */
  scrollPages(pages: number): void { this.instance.scrollPages(pages); }
  /** Scroll the xterm viewport by lines (negative = up). */
  scrollLines(lines: number): void { this.instance.scrollLines(lines); }

  /** Font-size manager while attached; null after detach(). */
  get fontSizeManager(): FontSizeManager | null {
    return this.instance?.fontSizeManager ?? null;
  }

  /** Current cell pixel dimensions; 8×16 fallback. */
  get cellDimensions(): { width: number; height: number } {
    return this.instance?.cellDimensions ?? { width: 8, height: 16 };
  }

  // ── Input mode ───────────────────────────────────────────────────────────

  setInputMode(mode: InputMode): void {
    this.inputRouter?.setMode(mode);
    // Sync to Jotai so React components react to the mode change.
    getDefaultStore().set(inputModeAtomFamily(this.sessionId), mode);
  }

  getInputMode(): InputMode {
    return this.inputRouter?.getMode() ?? { type: 'terminal' };
  }

}

/**
 * ResizeObserver wrapper: container size → cols/rows → controller.resize().
 *
 * The local xterm grid is applied on EVERY fire, synchronously. It has to be:
 * xterm paints at cols*cellW × rows*cellH, so any delay leaves it painting at
 * the previous container's pixel size — visible as a flicker (bare container
 * background where the terminal hasn't grown yet, or overflow where it hasn't
 * shrunk). The mobile input panel opens with no animation, which exposes that
 * gap as a hard flash rather than hiding it behind a transition.
 *
 * Only the PTY notification is debounced (200ms), so dragging a window doesn't
 * flood tmux with intermediate sizes. The first fire skips the debounce so tmux
 * is at the right size before the session attaches.
 *
 * Exported so consumers can type/instantiate the resize controller when
 * composing the terminal at the boundary.
 */
export class ResizeController {
  private controller: TerminalController;
  private observer: ResizeObserver | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isFirstFire = true;
  private lastContainer = { width: 0, height: 0 };
  private lastCell = { width: 8, height: 16 };

  constructor(controller: TerminalController) {
    this.controller = controller;
  }

  observe(container: HTMLElement, cellWidth: number, cellHeight: number): void {
    if (cellWidth <= 0 || cellHeight <= 0) { return; }
    this.dispose();
    this.isFirstFire = true;
    this.lastCell = { width: cellWidth, height: cellHeight };
    this.lastContainer = { width: 0, height: 0 };

    this.observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        this.lastContainer = { width, height };
        // Use the live cell size (refreshed by remeasure() on font-size zoom),
        // not the stale observe()-time closure params.
        const cell = this.lastCell;
        const cols = Math.max(1, Math.floor(width / cell.width));
        const rows = Math.max(1, Math.floor(height / cell.height));
        if (cols < 2 || rows < 2) { continue; }

        // Publish to the atom the state machine reads on (re)attach so
        // client.attach / beginRelay carry the current viewport size. Covers
        // both the immediate first fire and the debounced subsequent fires.
        getDefaultStore().set(lastResizeAtom, { cols, rows });

        if (this.isFirstFire) {
          this.isFirstFire = false;
          this.controller.resize(cols, rows);
          continue;
        }

        // Local grid now — the container has already changed size, so xterm
        // must repaint at the new size in this same frame.
        this.controller.resizeLocal(cols, rows);

        // PTY notification debounced, so a drag sends one final size.
        if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
        this.debounceTimer = setTimeout(() => {
          this.controller.sendResize(cols, rows);
        }, 200);
      }
    });
    this.observer.observe(container);
  }

  /** Recompute cols/rows from the last observed container size and the LIVE
   *  cell size (used after font-size changes, when the container hasn't
   *  resized). Refreshes the stashed cell size so later observer fires also
   *  use it. */
  remeasure(): void {
    const { width, height } = this.lastContainer;
    if (width <= 0 || height <= 0) { return; }
    const cell = this.controller.cellDimensions;
    if (cell.width <= 0 || cell.height <= 0) { return; }
    this.lastCell = cell;
    const cols = Math.max(1, Math.floor(width / cell.width));
    const rows = Math.max(1, Math.floor(height / cell.height));
    if (cols < 2 || rows < 2) { return; }
    // Keep the atom fresh after a font-size zoom so a (re)attach uses the
    // recomputed cell count, not the stale pre-zoom size.
    getDefaultStore().set(lastResizeAtom, { cols, rows });
    this.controller.resize(cols, rows);
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = null;
  }
}
