// web/src/terminal/controller/TerminalController.ts
import { Terminal } from '@xterm/xterm';
import { getDefaultStore } from 'jotai';
import type { ConnectionState } from '../../hooks/useP2PConnection';
import { inputModeAtomFamily, type InputMode } from '../state/input';
import type { TerminalSession, TerminalStatus } from '../state/session';
import type { TerminalTransport } from '../transport/TerminalTransport';
import { InputRouter } from '../input/InputRouter';
import { TerminalInputHandler } from '../input/TerminalInputHandler';
import { CommandInputHandler } from '../input/CommandInputHandler';
import { SearchInputHandler } from '../input/SearchInputHandler';
import { AIInputHandler } from '../input/AIInputHandler';
import { CustomInputHandler } from '../input/CustomInputHandler';
import { TerminalRuntime } from '../runtime/TerminalRuntime';
import type { FontSizeManager } from '../FontSizeManager';

export interface TerminalControllerOptions {
  rendererType: 'webgl' | 'canvas';
  fontSize?: number;
  scrollback?: number;
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
  private runtime: TerminalRuntime | null = null;
  private transportFactory: () => TerminalTransport;
  private transport: TerminalTransport | null = null;
  private resizeController: ResizeController | null = null;
  private inputRouter: InputRouter | null = null;
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
    private options: TerminalControllerOptions = { rendererType: 'canvas' },
  ) {
    this.session = session;
    this.transportFactory = transportFactory;
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
    const runtime = new TerminalRuntime(this.options);
    runtime.onCellSizeChange = () => {
      this.resizeController?.remeasure();
    };
    const terminal = runtime.terminal;

    this.transport = transport;
    this.runtime = runtime;
    this._terminal = terminal;
    this.attached = true;

    runtime.open(element);
    runtime.installMobileInput(element, (text) => { this.transport?.send(text); });

    // Transport → xterm: display output as it arrives.
    transport.onOutput = (data: Uint8Array) => { terminal.write(data); };
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

    this.runtime?.dispose();
    this.runtime = null;
    this._terminal = null;

    this.transport?.dispose();
    this.transport = null;
  }

  // ── Data flow ───────────────────────────────────────────────────────────

  /** Write data to the xterm display (e.g. from an external source). */
  write(data: string | Uint8Array): void {
    this._terminal?.write(data);
  }

  /** Send user input to the transport (→ PTY). */
  send(data: string): void {
    this.transport?.send(data);
  }

  // ── Terminal actions ────────────────────────────────────────────────────

  /** Resize the local xterm grid optimistically and notify the transport. */
  resize(cols: number, rows: number): void {
    this._terminal?.resize(cols, rows);
    this.transport?.sendResize(cols, rows);
  }

  focus(): void {
    this._terminal?.focus();
  }

  clear(): void {
    this._terminal?.clear();
  }

  paste(text: string): void {
    this._terminal?.paste(text);
  }

  // ── Scroll / font-size / cell dimensions ─────────────────────────────────

  /** Scroll the xterm viewport to the bottom. */
  scrollToBottom(): void { this.runtime?.scrollToBottom(); }
  /** Scroll the xterm viewport by whole pages (negative = up). */
  scrollPages(pages: number): void { this.runtime?.scrollPages(pages); }
  /** Scroll the xterm viewport by lines (negative = up). */
  scrollLines(lines: number): void { this.runtime?.scrollLines(lines); }

  /** Font-size manager while attached; null after detach(). */
  get fontSizeManager(): FontSizeManager | null {
    return this.runtime?.fontSizeManager ?? null;
  }

  /** Current cell pixel dimensions; 8×16 fallback. */
  get cellDimensions(): { width: number; height: number } {
    return this.runtime?.cellDimensions ?? { width: 8, height: 16 };
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
 * The first fire is sent immediately so tmux is at the right size before the
 * session attaches; subsequent fires (window drags) are debounced at 200ms to
 * avoid flooding tmux with intermediate sizes.
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
        const cols = Math.max(1, Math.floor(width / cellWidth));
        const rows = Math.max(1, Math.floor(height / cellHeight));
        if (cols < 2 || rows < 2) { continue; }

        if (this.isFirstFire) {
          this.isFirstFire = false;
          this.controller.resize(cols, rows);
          continue;
        }

        if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
        this.debounceTimer = setTimeout(() => {
          this.controller.resize(cols, rows);
        }, 200);
      }
    });
    this.observer.observe(container);
  }

  /** Recompute cols/rows from the last observed size + current cell size
   *  (used after font-size changes, when the container hasn't resized). */
  remeasure(): void {
    const { width, height } = this.lastContainer;
    if (width <= 0 || height <= 0) { return; }
    const cols = Math.max(1, Math.floor(width / this.lastCell.width));
    const rows = Math.max(1, Math.floor(height / this.lastCell.height));
    if (cols < 2 || rows < 2) { return; }
    this.controller.resize(cols, rows);
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = null;
  }
}
