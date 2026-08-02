import { Terminal } from '@xterm/xterm';
import { Renderer } from './Renderer';
import { ThemeManager } from './ThemeManager';
import { TerminalSizeManager } from './TerminalSizeManager';
import { FontSizeManager } from './FontSizeManager';
import { InputManager } from './InputManager';
import { ConnectionManager } from './ConnectionManager';
import { MobileInput } from './MobileInput';
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
    _selectionService?: {
      shouldForceSelection: (e: MouseEvent) => boolean;
    };
  };
}

export class TerminalView {
  readonly terminal: Terminal;

  private size: TerminalSizeManager;
  private fontSize: FontSizeManager;
  private input: InputManager;
  private connection: ConnectionManager;
  /** On touch devices: a visible textarea that replaces xterm's hidden one. */
  private mobileInput: MobileInput | null = null;

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
    // Mobile: prevent scroll chaining out of the terminal and disable
    // pull-to-refresh when the terminal's own scroll hits a boundary.
    // touch-action is intentionally NOT set here — xterm's internal
    // .xterm-viewport is the actual scroll surface (scrollback buffer);
    // setting touch-action on the outer wrapper would redirect browser
    // touch-scroll to this container (which may not overflow) instead of
    // to the viewport. xterm handles touch natively for selection.
    // NOTE: -webkit-overflow-scrolling is intentionally omitted — it is
    // deprecated since iOS 13 and creates a separate compositing layer
    // that can intercept touch events, preventing the hidden textarea
    // from receiving focus on mobile (IME/keyboard won't appear).
    scrollContainer.style.cssText =
      'width:100%; height:100%; overflow:auto;' +
      'overscroll-behavior-y:contain;';

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

    // ── Mobile: replace xterm's hidden textarea with our own ──────────
    // xterm.js is designed for physical keyboards and hides its textarea
    // off-screen.  On touch devices we create a visible textarea that the
    // browser and all IMEs can interact with natively — no composition
    // event patches, no focus tricks, no per-IME edge cases.
    //
    // xterm continues to render output.  Our MobileInput handles all
    // keyboard/IME input and sends committed text directly to the PTY.
    if ('ontouchstart' in window) {
      this.mobileInput = new MobileInput(
        this.terminal.element!,
        scrollContainer,
        {
          onSend: (text) => {
            if (!this.isDisposed) { this.connection.send(text); }
          },
        },
      );

      // Tap the terminal area → focus our textarea.
      const handleTouchStart = () => {
        if (this.isDisposed) { return; }
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) { return; }
        this.mobileInput!.focus();
      };
      scrollContainer.addEventListener('touchstart', handleTouchStart, { passive: true });
    }

    // Always use local text selection even when tmux SGR mouse mode is
    // active.  Without this, xterm.js sends button events to the PTY as
    // SGR sequences — tmux captures them for copy-mode selection, and
    // the user can't select text without holding Shift.  Wheel events
    // are unaffected and still reach tmux for copy-mode scroll.
    const sel = (this.terminal as unknown as XtermInternals)._core?._selectionService;
    if (sel) { sel.shouldForceSelection = () => true; }

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
    if (this.isDisposed) { return; }
    // Route Ctrl+D through the same handler as the keyboard path.
    if (text === '\x04') { this.onCtrlD?.(); return; }
    // On mobile, send via MobileInput (it's just a thin wrapper around
    // connection.send — same as desktop path).
    if (this.mobileInput) { this.mobileInput.sendText(text); return; }
    this.connection.send(text);
  }

  /** Focus the active input element (mobile: our textarea; desktop: xterm). */
  focus(): void {
    if (this.mobileInput) { this.mobileInput.focus(); }
    else { this.terminal.focus(); }
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
    this.mobileInput?.dispose();
    this.input.dispose();
    this.size.dispose();
    this.connection.dispose();
    this.terminal.dispose();
  }
}
