// web/src/terminal/controller/TerminalController.ts
import { Terminal } from '@xterm/xterm';
import type { ConnectionState } from '@/platform/socket/types';
import type {
  DeviceProfile,
  InputMode,
  TerminalScrollbackMode,
  TerminalSession,
  TerminalStatus,
} from '../types';
import type { TerminalTransport } from '../transport/TerminalTransport';
import type { TerminalBootstrap } from '../bootstrap';
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
import {
  TerminalInteractionController,
  type TerminalSemanticKey,
} from '../interaction/TerminalInteractionController';
import { gridFor } from '../grid';
import type { FontSizeManager } from '../FontSizeManager';

/**
 * What replaces a buffer when a **complete** bootstrap arrives (#321): erase
 * the display, erase the scrollback, home the cursor. Deliberately not
 * `terminal.reset()`, which also resets modes — see
 * {@link TerminalController.hasSessionOutput}.
 */
const BOOTSTRAP_BUFFER_RESET = '\x1b[2J\x1b[3J\x1b[H';

/**
 * What a **truncated** bootstrap gets instead (#1305): erase the display and
 * home the cursor, but leave the scrollback alone.
 *
 * The agent's byte ceiling drops the *oldest* history, so a truncated snapshot
 * is newer but shorter than what a long-attached client already holds — its
 * scrollback budget is 10k lines (mobile) / 50k (desktop)
 * (`DeviceProfile.PROFILES`) against the agent's 5000-line, 512 KiB capture.
 * Erasing the scrollback for a snapshot that cannot refill it destroys context
 * the client is configured to keep, so the one thing the snapshot *can*
 * restore — the current screen — is what gets replaced. `\x1b[2J` erases the
 * viewport and leaves the scrollback; `\x1b[3J` is the half that would not
 * come back.
 */
const BOOTSTRAP_SCREEN_RESET = '\x1b[2J\x1b[H';

export interface TerminalControllerEvents {
  onTransportReady?: (ready: boolean) => void;
  onInputModeChange?: (sessionId: string, mode: InputMode) => void;
  onResize?: (sessionId: string, cols: number, rows: number) => void;
  onTitleChange?: (sessionId: string, title: string) => void;
}

export interface TerminalControllerOptions {
  rendererType: 'webgl' | 'canvas';
  fontSize?: number;
  /** xterm's line-height: a multiple of the font box, from the Experience tokens. */
  lineHeight?: number;
  scrollback?: number;
  /**
   * Device class this terminal was built for. 'mobile' swaps xterm's hidden
   * helper textarea for {@link MobileImeInput} so soft keyboards and IMEs have
   * a real, cursor-anchored element to attach to.
   */
  deviceProfile?: DeviceProfile;
  scrollbackMode?: TerminalScrollbackMode;
  events?: TerminalControllerEvents;
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
  private interaction: TerminalInteractionController | null = null;
  private capsuleOcclusionScroll: CapsuleOcclusionScroll | null = null;
  private titleUnsub: (() => void) | null = null;
  private useMobileIme: boolean;
  private readonly scrollbackMode: TerminalScrollbackMode;
  private attached = false;
  /**
   * Whether the transport has delivered any of this session's output into this
   * xterm. Latches — output arriving is the only transition — and a bootstrap
   * counts, because the buffer it replaces is gone while what replaced it is
   * history the user can see.
   *
   * Read by the attach path (`!hasSessionOutput` ⇒ ask for a bootstrap, #321).
   * A local {@link TerminalController.write} deliberately does not set it: that
   * writes display, not history, and a page whose first session output is the
   * snapshot must still be able to ask for one.
   */
  private _hasSessionOutput = false;
  events?: TerminalControllerEvents;

  /** Callbacks → Jotai */
  onStateChange: ((status: TerminalStatus) => void) | null = null;
  onTitleChange: ((title: string) => void) | null = null;
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
    this.scrollbackMode = options.scrollbackMode ?? 'legacy';
    this.events = options.events;
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

  /** True when xterm is open in the DOM and transport handlers are wired. */
  isViewportAttached(): boolean {
    return this.attached;
  }

  /** Create xterm, mount on `element`, and wire the transport to it. */
  attach(element: HTMLElement): void {
    const terminal = this.instance.terminal;
    if (this.instance.isDisposed) {
      return;
    }

    // Same container — transport-only rewire (P2P socket / route changed).
    if (this.attached && terminal.element?.parentElement === element) {
      this.rewireTransport(terminal);
      return;
    }

    // Reparent to a new viewport container (React remount). Same teardown as a
    // full detach, minus dropping the instance — see `teardownTerminalUi`.
    if (this.attached && terminal.element?.parentElement !== element) {
      this.teardownTerminalUi();
      this.teardownTransport();
      this.instance.detach();
      this.attached = false;
    }
    if (this.attached) { return; }

    this.instance.attach(element);
    if (!terminal.element) {
      this.teardownTransport();
      return;
    }

    this.attached = true;
    this._terminal = terminal;
    this.rewireTransport(terminal);
    this.wireTerminalUi(element, terminal);
  }

  /** Swap ConnectionManager after P2P reconnect without tearing down xterm. */
  private rewireTransport(terminal: Terminal): void {
    this.teardownTransport();
    const transport = this.transportFactory();
    this.transport = transport;
    transport.onOutput = (data: Uint8Array, bootstrap?: TerminalBootstrap) => {
      // A bootstrap is the session's history, not more output: it **replaces**
      // this buffer instead of appending to it, which is the whole reason the
      // agent can re-send history on every attach that needs one without the
      // user ending up with two copies on screen (#321).
      //
      // The wipe is escape sequences rather than `terminal.reset()`, which
      // would also leave every mode the application set — including the
      // alternate screen of a TUI whose pane this snapshot came from. Erase
      // display, erase scrollback, cursor home: the three things a replaced
      // buffer needs, and nothing else.
      //
      // A snapshot the agent had to cut short is the one case that does not get
      // the third one — it is not a history that can stand in for what the
      // client already has (#1305).
      if (bootstrap) {
        terminal.write(bootstrap.truncated ? BOOTSTRAP_SCREEN_RESET : BOOTSTRAP_BUFFER_RESET);
      }
      const follow = this.capsuleOcclusionScroll?.snapshotFollowing() ?? false;
      terminal.write(data, () => {
        if (follow) {
          this.capsuleOcclusionScroll?.afterOutputWhileFollowing();
        }
      });
      this.markSessionOutput();
    };
    transport.onResize = (cols: number, rows: number) => { terminal.resize(cols, rows); };
    transport.onStateChange = (state: ConnectionState) => {
      this.onStateChange?.(mapConnectionState(state));
    };
    transport.onError = (err: Error) => { this.onError?.(err); };
    transport.onDisconnect = () => { this.onDisconnect?.(); };
    this.events?.onTransportReady?.(true);
  }

  /**
   * Called from the output path, so it stays cheap: the flag check is the whole
   * cost on every frame after the first. No event — a reader at attach time is
   * what the flag is for, and a consumer that had to be notified would be one
   * more thing to keep in step with a fact that never un-sets.
   */
  private markSessionOutput(): void {
    this._hasSessionOutput = true;
  }

  /**
   * Whether this xterm already holds the session's history. False only for a
   * buffer no session output has reached — a fresh xterm, which is exactly what
   * a page reload produces and exactly the case a bootstrap exists for.
   */
  get hasSessionOutput(): boolean {
    return this._hasSessionOutput;
  }

  private teardownTransport(): void {
    this.events?.onTransportReady?.(false);
    if (this.transport) {
      this.transport.onOutput = null;
      this.transport.onResize = null;
      this.transport.onStateChange = null;
      this.transport.onError = null;
      this.transport.onDisconnect = null;
      this.transport.dispose();
      this.transport = null;
    }
  }

  private wireTerminalUi(element: HTMLElement, terminal: Terminal): void {
    this.instance.onCellSizeChange = () => {
      this.resizeController?.remeasure();
    };

    const capsuleHost = element.closest('[data-terminal-capsule-host]');
    if (this.scrollbackMode === 'local-buffer' && capsuleHost instanceof HTMLElement) {
      this.capsuleOcclusionScroll = new CapsuleOcclusionScroll(
        terminal,
        capsuleHost,
        () => this.cellDimensions.height,
      );
      requestAnimationFrame(() => {
        if (!this.attached || !this.capsuleOcclusionScroll) { return; }
        this.capsuleOcclusionScroll.bind();
      });
    }

    // Retained, not fire-and-forget: a persistent TerminalInstance survives
    // every attach, so an un-disposed title listener accumulates one per
    // attach and is never released (#1096).
    const titleSub = terminal.onTitleChange((title: string) => {
      this.onTitleChange?.(title);
    });
    this.titleUnsub = () => titleSub.dispose();

    const transport = this.transport;
    if (!transport) { return; }

    const router = this.inputRouter ?? this.initInputRouter();
    this.interaction = new TerminalInteractionController(terminal, (data) => {
      this.inputSourceManager.setActiveSource('keyboard');
      this.transport?.send(data);
    });
    const terminalHandler = new TerminalInputHandler(this.interaction);
    router.register(terminalHandler);
    terminalHandler.activate();

    if (this.useMobileIme && terminal.element) {
      this.mobileIme = new MobileImeInput(terminal, terminal.element, {
        onCommitText: (text) => this.interaction?.sendText(text),
        onPaste: (text) => this.interaction?.paste(text),
        onSemanticKey: (key) => {
          this.interaction?.trySendSemanticKey(key);
        },
      });
    }

    this.resizeController = new ResizeController(this);
    requestAnimationFrame(() => {
      if (!this.attached) { return; }
      const dims = this.cellDimensions;
      this.resizeController?.observe(element, dims.width, dims.height);
    });
  }

  /**
   * Release everything `wireTerminalUi` bound to the mounted terminal, leaving
   * the xterm instance itself alive.
   *
   * One method, called by both `detach()` and the reparent branch of
   * `attach()`. Those two used to tear down different subsets — reparent
   * released the transport and the capsule scroll but left the input handler,
   * the IME, the resize observer and the title subscription wired — so a
   * viewport remount leaked a subscription that the next attach then doubled
   * (#1096). Converging them is the point, not a tidy-up.
   */
  private teardownTerminalUi(): void {
    this.resizeController?.dispose();
    this.resizeController = null;

    this.mobileIme?.dispose();
    this.mobileIme = null;

    this.titleUnsub?.();
    this.titleUnsub = null;

    this.capsuleOcclusionScroll?.dispose();
    this.capsuleOcclusionScroll = null;

    // `dispose`, not `setMode`: setMode deactivates the current handler and
    // then activates the one for the requested mode — and the requested mode
    // is the active one — so it left a live `terminal.onData` subscription on
    // a router that was dropped immediately after, with nothing left holding a
    // reference to dispose it. Every keystroke was then sent once per leaked
    // subscription, which is `x` arriving as `xx` (#1096).
    this.inputRouter?.dispose();
    this.inputRouter = null;

    this.interaction = null;
  }

  /** Dispose xterm, transport, and the resize observer. */
  detach(): void {
    if (!this.attached) { return; }
    this.attached = false;

    this.teardownTerminalUi();
    this.teardownTransport();

    this.instance.detach();
    this._terminal = null;
  }

  /** Tear down xterm, transport, and GPU resources (controller replacement / unmount). */
  dispose(): void {
    this.detach();
    this.instance.dispose();
  }

  // ── Data flow ───────────────────────────────────────────────────────────

  /**
   * Write data to the xterm display (e.g. from an external source).
   *
   * Display, not session history: this does not lift
   * {@link TerminalController.hasSessionOutput}, so a controller that has only
   * ever been written to here still asks for a bootstrap on attach.
   */
  write(data: string | Uint8Array): void {
    const follow = this.capsuleOcclusionScroll?.snapshotFollowing() ?? false;
    this._terminal?.write(data, () => {
      if (follow) {
        this.capsuleOcclusionScroll?.afterOutputWhileFollowing();
      }
    });
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
    this.handleInput({ source, data, timestamp: Date.now() });
  }

  /**
   * Terminal Keys / capsule — a semantic key when there is one (#1096).
   *
   * `seq` is optional because a semantic key has no bytes of its own: encoding
   * it is the interaction layer's job, and it depends on the terminal's mode.
   * The caller supplies one or the other, never both.
   */
  sendPhysKey(key: { seq?: string; semanticKey?: TerminalSemanticKey }): void {
    if (key.semanticKey && this.interaction) {
      this.interaction.sendSemanticKey(key.semanticKey);
      return;
    }
    if (key.seq) {
      this.send(key.seq, 'component-input');
    }
  }

  /** Get the currently active input source. */
  getActiveInputSource(): import('../types').InputSource | null {
    return this.inputSourceManager.getActiveSource();
  }

  /** Apply attach-time stream cursor for gap catch-up (#1094). */
  seedStreamCursor(streamEpoch: number | undefined, streamCursor: number | undefined): void {
    this.transport?.seedStreamCursor?.(streamEpoch, streamCursor);
  }

  /** Gate keyboard / IME → PTY when this client is an observer (#1095). */
  setRemoteInputEnabled(enabled: boolean): void {
    if (this._terminal) {
      this._terminal.options.disableStdin = !enabled;
    }
    this.mobileIme?.setEnabled(enabled);
  }

  /**
   * Register a callback for input source changes.
   * Returns an unsubscribe function.
   */
  onInputSourceChange(callback: (source: import('../types').InputSource) => void): () => void {
    return this.inputSourceManager.onSourceChange(callback);
  }

  /**
   * Reconcile the input cursor against what the attach reply stated (#1307).
   *
   * Delegated like the rest of the transport surface: the controller is where
   * the React layer meets the transport, and the decision about what a moved
   * epoch or generation means belongs one level down.
   */
  seedInputCursor(seed: import('../transport/TerminalTransport').TerminalInputSeed): void {
    this.transport?.seedInputCursor?.(seed);
  }

  /** Flush any input waiting for the session to be attached. */
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
  scrollPages(pages: number): void {
    if (this.capsuleOcclusionScroll) {
      this.capsuleOcclusionScroll.scrollPages(pages);
      return;
    }
    this.instance.scrollPages(pages);
  }
  /** Scroll the xterm viewport by lines (negative = up). */
  scrollLines(lines: number): void {
    if (this.capsuleOcclusionScroll) {
      this.capsuleOcclusionScroll.scrollLines(lines);
      return;
    }
    this.instance.scrollLines(lines);
  }

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
    this.events?.onInputModeChange?.(this.sessionId, mode);
  }

  getInputMode(): InputMode {
    return this.inputRouter?.getMode() ?? { type: 'terminal' };
  }

  /** Publish viewport cols/rows to the React layer (attach sizing, debounced PTY resize). */
  publishViewportResize(cols: number, rows: number): void {
    this.events?.onResize?.(this.sessionId, cols, rows);
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
        const size = entry.contentRect;
        this.lastContainer = { width: size.width, height: size.height };
        // The content box, not the border box: `contentRect` excludes the
        // container's padding, which is the whole of `--terminal-pad-x`. Fitted
        // against the padded box the grid draws wider than the well that holds
        // it — #1092, in the fixture. Use the live cell size (refreshed by
        // remeasure() on font-size zoom), not the stale observe()-time params.
        const grid = gridFor(size, this.lastCell);
        if (grid === null) { continue; }

        // Publish to the atom the state machine reads on (re)attach so
        // client.attach / beginRelay carry the current viewport size. Covers
        // both the immediate first fire and the debounced subsequent fires.
        this.controller.publishViewportResize(grid.cols, grid.rows);

        if (this.isFirstFire) {
          this.isFirstFire = false;
          this.controller.resize(grid.cols, grid.rows);
          continue;
        }

        // Local grid now — the container has already changed size, so xterm
        // must repaint at the new size in this same frame.
        this.controller.resizeLocal(grid.cols, grid.rows);

        // PTY notification debounced, so a drag sends one final size.
        if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
        this.debounceTimer = setTimeout(() => {
          this.controller.sendResize(grid.cols, grid.rows);
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
    const grid = gridFor({ width, height }, cell);
    if (grid === null) { return; }
    // Keep the atom fresh after a font-size zoom so a (re)attach uses the
    // recomputed cell count, not the stale pre-zoom size.
    this.controller.publishViewportResize(grid.cols, grid.rows);
    this.controller.resize(grid.cols, grid.rows);
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = null;
  }
}
