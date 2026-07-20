import { Terminal } from '@xterm/xterm';
import { Renderer } from './Renderer';
import { ThemeManager } from './ThemeManager';
import { TerminalSizeManager } from './TerminalSizeManager';
import { FontSizeManager } from './FontSizeManager';
import { InputManager } from './InputManager';
import { ConnectionManager } from './ConnectionManager';
import type {
  TerminalViewOptions,
  TerminalViewState,
  ConnectionState,
} from './types';

const DEFAULT_FONT =
  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace";
const DEFAULT_FONT_SIZE = 14;

/**
 * Shape of xterm.js's undocumented internal state that exposes the current
 * cell pixel dimensions. Mirrors the same interface in TerminalSizeManager.
 */
interface XtermInternals {
  _core?: {
    _renderService?: {
      dimensions?: {
        css?: {
          cell?: {
            width: number;
            height: number;
          };
        };
      };
    };
  };
}

export class TerminalView {
  readonly terminal: Terminal;

  private size: TerminalSizeManager;
  private fontSize: FontSizeManager;
  private input: InputManager;
  private connection: ConnectionManager;

  private isDisposed = false;
  private attachTimer: ReturnType<typeof setTimeout> | null = null;
  /** Latest resize dimensions from ResizeObserver — passed to attach(). */
  private pendingResize: { cols: number; rows: number } | null = null;

  onStateChange: ((state: TerminalViewState) => void) | null = null;
  onCtrlD: (() => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onDisconnect: (() => void) | null = null;

  constructor(container: HTMLElement, options: TerminalViewOptions) {
    // DOM: container → scrollContainer(overflow:auto) → mountElement
    // scrollContainer fills its parent; mountElement is sized to
    // cols*cellW × rows*cellH by TerminalSizeManager. When mount > scroll,
    // browser-native scrollbars appear. When mount < scroll, container
    // background (#1e1e2e, set on `container` by the React component) fills
    // the remainder — no transform, no wrapper.
    const scrollContainer = document.createElement('div');
    scrollContainer.style.cssText = 'width:100%; height:100%; overflow:auto;';

    const mountElement = document.createElement('div');
    mountElement.style.cssText = 'position:relative;';

    scrollContainer.appendChild(mountElement);
    container.appendChild(scrollContainer);

    const initialFontSize = options.deviceProfile?.fontSize ?? DEFAULT_FONT_SIZE;

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: initialFontSize,
      fontFamily: DEFAULT_FONT,
      theme: options.theme,
      allowProposedApi: true,
      scrollback: options.deviceProfile?.scrollback ?? 10000,
    });

    // Renderer/ThemeManager created for constructor side effects.
    new Renderer(this.terminal, options.rendererType);
    new ThemeManager(this.terminal, options.theme);

    this.size = new TerminalSizeManager(this.terminal, mountElement);
    this.fontSize = new FontSizeManager(
      this.terminal,
      () => this.size.recompute(),
      initialFontSize,
    );
    this.input = new InputManager(this.terminal);
    this.connection = new ConnectionManager(options.connection);

    // Wire managers.
    this.input.onData((data: string) => {
      if (!this.isDisposed) { this.connection.send(data); }
    });
    this.input.onCtrlD(() => { this.onCtrlD?.(); });

    this.connection.onOutput = (data: string) => {
      if (!this.isDisposed) { this.terminal.write(data); }
    };
    this.connection.onStateChange = (state: ConnectionState, attempt: number) => {
      this.onStateChange?.({
        banner: state === 'reconnecting' ? 'reconnecting'
              : state === 'lost' ? 'failed'
              : 'none',
        reconnectAttempt: attempt,
        isConnected: state === 'connected',
      });
    };
    this.connection.onError = (err: Error) => { this.onError?.(err); };
    this.connection.onDisconnect = () => { this.onDisconnect?.(); };
    this.connection.onResize = (cols: number, rows: number) => {
      if (!this.isDisposed) { this.size.handleResize(cols, rows); }
    };

    this.terminal.open(mountElement);

    // Capture wheel events before xterm.js to let the browser scroll the
    // page naturally.  Without this, xterm.js consumes wheel events for its
    // internal scrollback buffer, which conflicts with the scroll container.
    mountElement.addEventListener(
      'wheel',
      (e) => { e.stopPropagation(); },
      { capture: true },
    );

    // Prime mount pixel size from xterm's default cols/rows (typically 80×24)
    // so the DOM has explicit dimensions before the first tmux resize arrives.
    // Once that arrives (usually < 100ms after client.attach) size flips to
    // the real pane size (typically 200×60).
    requestAnimationFrame(() => {
      if (!this.isDisposed) {
        this.size.handleResize(this.terminal.cols, this.terminal.rows);
      }
    });

    // Deferred attach (survives React StrictMode double-mount).
    // If the ResizeObserver fired before this timer, we pass the real
    // viewport dimensions so the agent pre-resizes tmux correctly.
    this.attachTimer = setTimeout(() => {
      if (this.isDisposed) { return; }
      const r = this.pendingResize;
      this.connection
        .attach(r?.cols, r?.rows)
        .catch(() => {});
    }, 50);
  }

  sendText(text: string): void {
    if (this.isDisposed) {
      return;
    }
    this.connection.send(text);
  }

  /** Send client viewport resize to the agent so tmux can resize its window.
   *  Updates the local xterm grid immediately (optimistic) so there's no
   *  flash of blank space while waiting for tmux to confirm. */
  sendResize(cols: number, rows: number): void {
    if (this.isDisposed) {
      return;
    }
    this.pendingResize = { cols, rows };
    // Optimistic local update — xterm re-renders immediately.
    this.size.handleResize(cols, rows);
    // Then tell tmux (agent → tmux resize-window → %window-resize → broadcast).
    this.connection.sendResize(cols, rows);
  }

  /** Current cell pixel dimensions — used by ResizeObserver to calculate cols/rows. */
  get cellDimensions(): { width: number; height: number } {
    // Read cell pixel size from xterm's internal render service.
    // Falls back to 8×16 (14px monospace defaults) if unavailable.
    const renderService = (this.terminal as unknown as XtermInternals)._core?._renderService;
    const width: number = renderService?.dimensions?.css?.cell?.width ?? 8;
    const height: number = renderService?.dimensions?.css?.cell?.height ?? 16;
    return { width, height };
  }

  /** No-op: TerminalSizeManager is driven by tmux resize events, not viewport fits. */
  refit(): void {
    // Kept on the handle for API compatibility; nothing to do.
  }

  /** Get the font-size manager for external zoom controls. */
  get fontSizeManager(): FontSizeManager {
    return this.fontSize;
  }

  /** Push a banner state from an external observer (e.g. React watching P2P). */
  setExternalBanner(banner: 'none' | 'reconnecting' | 'failed', attempt: number): void {
    if (this.isDisposed) {
      return;
    }
    this.onStateChange?.({
      banner,
      reconnectAttempt: attempt,
      isConnected: banner === 'none',
    });
  }

  /** Re-issue attach (tmux redraw) after a transport reconnect. */
  reattach(): void {
    if (this.isDisposed) {
      return;
    }
    this.connection.reattach().catch(() => {});
  }

  dispose(): void {
    this.isDisposed = true;
    if (this.attachTimer) { clearTimeout(this.attachTimer); this.attachTimer = null; }
    this.input.dispose();
    this.size.dispose();
    this.connection.dispose();
    this.terminal.dispose();
  }
}
