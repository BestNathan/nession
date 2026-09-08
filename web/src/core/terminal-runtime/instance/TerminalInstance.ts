import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Renderer } from '../Renderer';
import { ThemeManager } from '../ThemeManager';
import { FontSizeManager } from '../FontSizeManager';
import type { TerminalInstanceOptions } from '../types';

/**
 * HTMLElement augmented with `xtermInstance` — a reference to the Terminal
 * instance mounted inside it. Set by {@link TerminalInstance.attach} so E2E
 * tests can read the buffer (canvas/webgl renderers don't put text in the DOM).
 */
interface XtermMountElement extends HTMLElement {
  xtermInstance?: Terminal;
}

const DEFAULT_FONT =
  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace";
const DEFAULT_FONT_SIZE = 14;

/**
 * Stable xterm wrapper that persists across attach/detach cycles.
 * Created once in TerminalController constructor, not recreated on each attach.
 * Scrollback buffer is preserved because xterm state is in JS objects, not DOM.
 */
export class TerminalInstance {
  readonly terminal: Terminal;
  readonly fontSizeManager: FontSizeManager;
  private disposed = false;
  private fontSizeCallback: () => void = () => {};

  constructor(options: TerminalInstanceOptions) {
    const initialFontSize = options.fontSize ?? DEFAULT_FONT_SIZE;

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: initialFontSize,
      fontFamily: DEFAULT_FONT,
      allowProposedApi: true,
      scrollback: options.scrollback ?? 50000,
    });

    new Renderer(this.terminal, options.rendererType);
    new ThemeManager(this.terminal);

    this.fontSizeManager = new FontSizeManager(
      this.terminal,
      () => this.fontSizeCallback(),
      initialFontSize,
    );
  }

  set onCellSizeChange(cb: () => void) {
    this.fontSizeCallback = cb;
  }

  /** Attach xterm to container. Uses open() which preserves JS state. */
  attach(element: HTMLElement): void {
    if (this.disposed) {
      return;
    }
    if (this.terminal.element?.parentElement === element) {
      return;
    }
    if (this.terminal.element) {
      // xterm.open() is one-shot: once the terminal has been opened it returns
      // early when called again. Reparent the existing DOM tree so detach /
      // reattach preserves both the buffer and the renderer state.
      element.appendChild(this.terminal.element);
      (element as XtermMountElement).xtermInstance = this.terminal;
      this.terminal.refresh(0, this.terminal.rows - 1);
      return;
    }
    this.terminal.open(element);
    // Expose the Terminal instance on the container element so E2E tests can
    // read the buffer (canvas/webgl renderers don't put text in the DOM).
    (element as XtermMountElement).xtermInstance = this.terminal;
  }

  /** Detach from container — preserve JS buffer; drop stale DOM nodes. */
  detach(): void {
    if (this.disposed) {
      return;
    }
    this.terminal.element?.remove();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get cellDimensions(): { width: number; height: number } {
    const fallback = { width: 8, height: 16 };
    try {
      const rs = (this.terminal as unknown as {
        _core?: {
          _renderService?: {
            dimensions?: {
              css?: {
                cell?: { width: number; height: number };
              };
            };
          };
        };
      })._core?._renderService;
      if (!rs) {
        return fallback;
      }
      const dims = rs.dimensions;
      return {
        width: dims?.css?.cell?.width || fallback.width,
        height: dims?.css?.cell?.height || fallback.height,
      };
    } catch {
      // xterm's dimensions getter throws until the renderer finishes its first
      // layout pass (common right after open(), under StrictMode remount, or
      // when WebGL is still initializing).
      return fallback;
    }
  }

  scrollToBottom(): void { this.terminal.scrollToBottom(); }
  scrollPages(pages: number): void { this.terminal.scrollPages(pages); }
  scrollLines(lines: number): void { this.terminal.scrollLines(lines); }
  focus(): void { this.terminal.focus(); }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.terminal.dispose();
  }
}
