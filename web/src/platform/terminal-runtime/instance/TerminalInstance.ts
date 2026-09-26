import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { TERMINAL_METRICS } from '../../../../../design/generated/terminal';
import { Renderer } from '../Renderer';
import { ThemeManager, TERMINAL_MINIMUM_CONTRAST_RATIO } from '../ThemeManager';
import { FontSizeManager } from '../FontSizeManager';
import { cellDimensionsOf } from '../grid';
import type { TerminalInstanceOptions } from '../types';

/**
 * HTMLElement augmented with `xtermInstance` — a reference to the Terminal
 * instance mounted inside it. Set by {@link TerminalInstance.attach} so E2E
 * tests can read the buffer (canvas/webgl renderers don't put text in the DOM).
 */
interface XtermMountElement extends HTMLElement {
  xtermInstance?: Terminal;
}

export const DEFAULT_FONT =
  "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace";

/**
 * Fallback xterm metrics when no experience selected a profile.
 *
 * The terminal's own type size and leading are Experience values
 * (`experience.web.terminal` / `experience.app.terminal`), crossed to xterm
 * through `TERMINAL_METRICS` in `design/generated/terminal.ts` because xterm
 * reads them as JS options rather than as custom properties. Web is the
 * baseline because it is the experience the shell renders by default
 * (`ShellMain`'s `experience = 'web'`) and the one a terminal with no caller
 * profile belongs to.
 */
const BASELINE_METRICS = TERMINAL_METRICS.web;

/**
 * Start fetching the terminal face at module load rather than at first paint.
 * xterm measures one cell once, when it opens; see {@link TerminalInstance.remeasureOnFontLoad}
 * for the fallback when that still loses the race.
 */
function warmTerminalFont(): void {
  void document.fonts?.load(`${BASELINE_METRICS.fontSize}px ${DEFAULT_FONT}`).catch(() => {});
}

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
    const initialFontSize = options.fontSize ?? BASELINE_METRICS.fontSize;

    warmTerminalFont();

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: initialFontSize,
      // xterm's `lineHeight` is a multiple of the *measured font box*, not of
      // `fontSize` the way CSS `line-height` is. The token owns that unit note
      // (`experience.web.terminal.lineHeight`) — read it before changing this.
      lineHeight: options.lineHeight ?? BASELINE_METRICS.lineHeight,
      fontFamily: DEFAULT_FONT,
      allowProposedApi: true,
      scrollback: options.scrollback ?? 50000,
      // xterm adjusts a foreground that fails this ratio. Nession's own ANSI
      // slots already clear AA on the white ground, so this costs nothing
      // there; it exists for the colours we do not control — a user's
      // `ls --color`, a vim colorscheme, and the 256-colour cube, whose
      // light end (`#eeeeee` and friends) is invisible on white. Without
      // `extendedAnsi` those slots fall back to xterm's dark-tuned default
      // ramp, and this ratio is what keeps them legible.
      minimumContrastRatio: TERMINAL_MINIMUM_CONTRAST_RATIO,
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
    this.remeasureOnFontLoad();
  }

  /**
   * xterm measures one cell at `open()` and caches it. If the webfont lands
   * after that, the cached cell is the fallback's, and every glyph is then
   * drawn off-cell until something else forces a re-measure. `warmTerminalFont`
   * makes that unlikely; this closes it.
   */
  private remeasureOnFontLoad(): void {
    void document.fonts?.ready.then(() => {
      if (this.disposed) {
        return;
      }
      // xterm re-measures when `fontFamily` *changes*, and its option setter
      // short-circuits equal values — so step through a different string.
      // A trailing space is a valid CSS font-family list; nothing trims it.
      const family = this.terminal.options.fontFamily ?? DEFAULT_FONT;
      this.terminal.options.fontFamily = `${family} `;
      this.terminal.options.fontFamily = family;
      this.fontSizeCallback();
    });
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
    return cellDimensionsOf(this.terminal);
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
