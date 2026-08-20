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
    this.terminal.open(element);
    // Expose the Terminal instance on the container element so E2E tests can
    // read the buffer (canvas/webgl renderers don't put text in the DOM).
    (element as XtermMountElement).xtermInstance = this.terminal;
  }

  /** Detach from container. No-op: terminal instance stays alive. */
  detach(): void {
    // Intentionally empty
  }

  get cellDimensions(): { width: number; height: number } {
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
    return {
      width: rs?.dimensions?.css?.cell?.width || 8,
      height: rs?.dimensions?.css?.cell?.height || 16,
    };
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
