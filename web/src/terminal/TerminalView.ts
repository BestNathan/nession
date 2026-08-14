import { Terminal } from '@xterm/xterm';
import { Renderer } from './Renderer';
import { ThemeManager } from './ThemeManager';
import { TerminalSizeManager } from './TerminalSizeManager';
import { FontSizeManager } from './FontSizeManager';
import { InputManager } from './InputManager';
import { ConnectionManager } from './ConnectionManager';
import { MouseIntentResolver } from './MouseIntentResolver';
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
  };
}

export class TerminalView {
  readonly terminal: Terminal;

  private size: TerminalSizeManager;
  private fontSize: FontSizeManager;
  private input: InputManager;
  /** Public so the React state machine can flush buffered input on attach. */
  readonly connection: ConnectionManager;
  /** Resolves click vs drag intent so TUI apps receive mouse events. */
  private mouseIntent: MouseIntentResolver;
  /** On touch devices: a visible textarea that replaces xterm's hidden one. */
  private mobileInput: MobileInput | null = null;

  private isDisposed = false;

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

    // MouseIntentResolver: controls shouldForceSelection gate.
    // Single click/drag (mouse active) → xterm generates SGR → tmux.
    // Double/triple click, Shift, mouse inactive → local selection.
    this.mouseIntent = new MouseIntentResolver(this.terminal);

    // Wire managers.
    this.input.onData((data: string) => {
      if (!this.isDisposed) { this.connection.send(data); }
    });
    this.input.onCtrlD(() => { this.onCtrlD?.(); });

    this.connection.onOutput = (data: Uint8Array) => {
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
        this.terminal,
        scrollContainer,
        {
          onSend: (text) => {
            if (!this.isDisposed) { this.connection.send(text); }
          },
        },
      );

      // Tap the terminal area → focus our textarea. Use touchstart +
      // touchend to detect taps (no movement) vs scrolls/swipes so the
      // keyboard only appears on deliberate taps, not during scrolling.
      let tapStartX = 0;
      let tapStartY = 0;
      const TAP_MOVE_THRESHOLD = 10; // px — max movement to count as a tap

      const handleTouchStart = (e: TouchEvent) => {
        if (this.isDisposed) { return; }
        const t = e.touches[0];
        tapStartX = t.clientX;
        tapStartY = t.clientY;
      };

      const handleTouchEnd = () => {
        if (this.isDisposed) { return; }
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) { return; }
        this.mobileInput!.focus();
      };

      // Use a pointer-tracking wrapper: record start position on touchstart,
      // then only focus on touchend IF the touch didn't move much.
      // The actual focus call is wrapped so we can discard scroll gestures.
      const touchEndWrapper = (e: TouchEvent) => {
        if (this.isDisposed) { return; }
        const t = e.changedTouches[0];
        const dx = t.clientX - tapStartX;
        const dy = t.clientY - tapStartY;
        if (Math.abs(dx) < TAP_MOVE_THRESHOLD && Math.abs(dy) < TAP_MOVE_THRESHOLD) {
          handleTouchEnd();
        }
      };

      scrollContainer.addEventListener('touchstart', handleTouchStart, { passive: true });
      scrollContainer.addEventListener('touchend', touchEndWrapper, { passive: true });
    }

    // MouseIntentResolver (see above) distinguishes click from drag.
    // No manual shouldForceSelection patch needed — the resolver
    // handles both paths.

    // Prime mount pixel size from xterm's default cols/rows (typically 80×24)
    // so the DOM has explicit dimensions before the first tmux resize arrives.
    // Once that arrives (usually < 100ms after client.attach) size flips to
    // the real pane size (typically 200×60).
    requestAnimationFrame(() => {
      if (!this.isDisposed) {
        this.size.handleResize(this.terminal.cols, this.terminal.rows);
      }
    });
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

  /** Scroll the scrollback buffer by whole pages (negative = towards history). */
  scrollPages(pages: number): void {
    if (this.isDisposed) { return; }
    this.terminal.scrollPages(pages);
  }

  /** Scroll the scrollback buffer by lines (negative = towards history). */
  scrollLines(lines: number): void {
    if (this.isDisposed) { return; }
    this.terminal.scrollLines(lines);
  }

  /** Jump the viewport to the newest output (bottom of the scrollback). */
  scrollToBottom(): void {
    if (this.isDisposed) { return; }
    this.terminal.scrollToBottom();
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

  /** Re-issue attach (tmux redraw) after a transport reconnect.
   *  Attach timing is now owned by the React state machine
   *  (terminalSessionStateAtom) — ConnectionManager is pure transport.
   *  Kept as a no-op so Terminal.tsx's P2P effect still compiles until the
   *  state machine effect lands. */
  reattach(): void {
    // client.attach is driven by the React layer, not ConnectionManager.
  }

  dispose(): void {
    this.isDisposed = true;
    this.mobileInput?.dispose();
    this.mouseIntent.dispose();
    this.input.dispose();
    this.size.dispose();
    this.connection.dispose();
    this.terminal.dispose();
  }
}
