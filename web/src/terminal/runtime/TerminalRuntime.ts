import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Renderer } from '../Renderer';
import { ThemeManager } from '../ThemeManager';
import { FontSizeManager } from '../FontSizeManager';
import { MobileInput } from '../MobileInput';
import { MouseIntentResolver } from '../MouseIntentResolver';

const DEFAULT_FONT =
  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace";
const DEFAULT_FONT_SIZE = 14;

interface XtermInternals {
  _core?: {
    _renderService?: {
      dimensions?: { css?: { cell?: { width: number; height: number } } };
    };
  };
}

export interface TerminalRuntimeOptions {
  rendererType: 'webgl' | 'canvas';
  fontSize?: number;
  scrollback?: number;
}

/**
 * Owns the xterm instance and everything wired to it: renderer, theme, font
 * size, addons, mobile input (touch), and mouse-intent resolution. The
 * controller delegates to this instead of constructing a bare Terminal, so the
 * two implementations share one lifecycle.
 */
export class TerminalRuntime {
  readonly terminal: Terminal;
  readonly fontSizeManager: FontSizeManager;
  private mouseIntent: MouseIntentResolver;
  private mobileInput: MobileInput | null = null;
  private disposed = false;
  /** Settable hook run after font-size changes (wired by the controller). */
  private fontSizeCallback: () => void = () => {};

  constructor(options: TerminalRuntimeOptions) {
    const initialFontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: initialFontSize,
      fontFamily: DEFAULT_FONT,
      allowProposedApi: true,
      scrollback: options.scrollback ?? 10000,
    });

    // Renderer/ThemeManager created for constructor side effects (addon load,
    // theme apply) — same pattern as the legacy TerminalView.
    new Renderer(this.terminal, options.rendererType);
    new ThemeManager(this.terminal);
    this.mouseIntent = new MouseIntentResolver(this.terminal);
    // The controller wires this via the setter below (fontSize → resize).
    this.fontSizeManager = new FontSizeManager(
      this.terminal,
      () => this.fontSizeCallback(),
      initialFontSize,
    );
  }

  /** Wire a callback run after font-size changes (e.g. re-run resize). */
  set onCellSizeChange(cb: () => void) {
    this.fontSizeCallback = cb;
  }

  /** Mount xterm into `element`. */
  open(element: HTMLElement): void {
    this.terminal.open(element);
  }

  /** On touch devices, install a visible textarea for IME input. */
  installMobileInput(parent: HTMLElement, onSend: (text: string) => void): void {
    if ('ontouchstart' in window && !this.mobileInput) {
      this.mobileInput = new MobileInput(this.terminal, parent, { onSend });
    }
  }

  /** Cell pixel size, falling back to 8×16 (14px monospace defaults). */
  get cellDimensions(): { width: number; height: number } {
    const rs = (this.terminal as unknown as XtermInternals)._core?._renderService;
    // Falsy (`||`) fallback: xterm reports 0×0 before the render service has
    // measured real cells (e.g. pre-layout / jsdom), which is not a usable size.
    return {
      width: rs?.dimensions?.css?.cell?.width || 8,
      height: rs?.dimensions?.css?.cell?.height || 16,
    };
  }

  scrollToBottom(): void { this.terminal.scrollToBottom(); }
  scrollPages(pages: number): void { this.terminal.scrollPages(pages); }
  scrollLines(lines: number): void { this.terminal.scrollLines(lines); }

  focus(): void {
    if (this.mobileInput) { this.mobileInput.focus(); }
    else { this.terminal.focus(); }
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.mobileInput?.dispose();
    this.mouseIntent.dispose();
    this.terminal.dispose();
  }
}
