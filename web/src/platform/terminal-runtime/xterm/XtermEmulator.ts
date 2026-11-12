import { Terminal, type ITerminalOptions, type ITheme, type ILink } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { TERMINAL_METRICS } from '../../../../../design/generated/terminal';
import { measuredCellDimensionsOf, readBufferSnapshot, readLogicalLine, logicalLinePoint, readModeSnapshot, cellSizeOf } from './XtermMetrics';
import { mapLineLinks } from './LineLinks';
import { XtermAddonHost } from './XtermAddonHost';
import { XtermRenderer, type TerminalRendererType } from './XtermRenderer';
import { ThemeManager, TERMINAL_MINIMUM_CONTRAST_RATIO } from './ThemeManager';
import { FontSizeManager } from './FontSizeManager';
import type { PixelSize } from '../grid';
import type {
  TerminalBufferSnapshot,
  TerminalCellSize,
  TerminalClipboardHost,
  TerminalDisposable,
  TerminalEmulator,
  TerminalLinkMatcher,
  TerminalModeSnapshot,
  TerminalWriteOrigin,
} from '../emulator';

/**
 * HTMLElement augmented with `xtermInstance` — a reference to the Terminal
 * instance mounted inside it. Set by {@link XtermEmulator.mount} so E2E tests
 * can read the buffer (canvas/webgl renderers don't put text in the DOM).
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

/** Why the cell box changed: a user zoom, or the webfont settling. */
export type CellSizeChangeReason = 'zoom' | 'font-load';

/**
 * Start fetching the terminal face at module load rather than at first paint.
 * xterm measures one cell once, when it opens; see {@link XtermEmulator.remeasureOnFontLoad}
 * for the fallback when that still loses the race.
 */
function warmTerminalFont(): void {
  void document.fonts?.load(`${BASELINE_METRICS.fontSize}px ${DEFAULT_FONT}`).catch(() => {});
}

/** Options for one engine instance. */
export interface XtermEmulatorOptions {
  rendererType: TerminalRendererType;
  fontSize?: number;
  /**
   * xterm's own `lineHeight`: a multiple of the terminal font's measured box,
   * not of `fontSize` the way CSS `line-height` is. Owned by
   * `experience.{web,app}.terminal.lineHeight`.
   */
  lineHeight?: number;
  scrollback?: number;
  /**
   * Static xterm options for a terminal with no transport (the canonical
   * fixture). Runtime options — font, theme, renderer, addons, input — stay
   * owned by this class.
   */
  terminalOptions?: Partial<ITerminalOptions>;
  theme?: ITheme;
}

/**
 * The single production owner of one `@xterm/xterm` `Terminal` instance
 * (#2581).
 *
 * It constructs the terminal, installs the renderer/theme/addon lifecycle,
 * mounts and reparents it without destroying the buffer, applies ordered
 * writes and resizes, and exposes the business-neutral {@link TerminalEmulator}
 * port. It also owns the translation from logical-line text offsets to buffer
 * cells, so feature link matchers never do cell arithmetic.
 *
 * The raw `Terminal` handle (`rawTerminal`) is an internal escape hatch for
 * this module's platform consumers and tests. `nession/no-direct-xterm`
 * rejects importing this module from Product/UI, so the hatch is not reachable
 * from the layers it would hurt. Mutable paths — `write` and `resize` — must
 * stay behind `SerializedTerminalWriter`.
 */
export class XtermEmulator implements TerminalEmulator {
  readonly terminal: Terminal;
  readonly fontSizeManager: FontSizeManager;
  private readonly addons: XtermAddonHost;
  private readonly renderer: XtermRenderer;
  private disposed = false;
  /**
   * The host this terminal is currently mounted in (#2879). The debug/E2E
   * `xtermInstance` property lives on the host; ownership must be released by
   * identity on detach/reparent/dispose so a host (or a test holding it) can
   * never retain a replaced Terminal.
   */
  private mountHost: HTMLElement | null = null;
  private fontSizeCallback: (reason: CellSizeChangeReason) => void = () => {};
  /**
   * Provenance of the write xterm is parsing right now (#2598). The ordered
   * writer serializes writes, so exactly one origin is active at a time; the
   * clipboard host reads it from each parser callback.
   */
  private writeOrigin: TerminalWriteOrigin = { source: 'live' };
  private clipboardDisposable: TerminalDisposable | null = null;
  /**
   * Product matchers, kept beside the xterm link providers (#3187). xterm's
   * linkifier only listens to mouse events, so a touch tap never reaches it;
   * this registry lets the tap handler ask the same matchers about the cell
   * the finger landed on.
   */
  private readonly linkMatchers = new Map<TerminalLinkMatcher, number>();
  private linkTouchDisposable: TerminalDisposable | null = null;
  private tapCandidate: {
    identifier: number;
    x: number;
    y: number;
    moved: boolean;
    startedAt: number;
  } | null = null;

  constructor(options: XtermEmulatorOptions) {
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
      ...options.terminalOptions,
    });

    this.addons = new XtermAddonHost(this.terminal);
    this.renderer = new XtermRenderer(this.addons, options.rendererType);
    new ThemeManager(this.terminal, options.theme);
    this.fontSizeManager = new FontSizeManager(
      this.terminal,
      () => this.fontSizeCallback('zoom'),
      initialFontSize,
    );
  }

  set onCellSizeChange(cb: (reason: CellSizeChangeReason) => void) {
    this.fontSizeCallback = cb;
  }

  // ── Port: identity and lifecycle ────────────────────────────────────────

  get element(): HTMLElement | null {
    return this.terminal.element ?? null;
  }

  get cols(): number {
    return this.terminal.cols;
  }

  get rows(): number {
    return this.terminal.rows;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Attach xterm to a container. Uses open() which preserves JS state. */
  mount(host: HTMLElement): void {
    if (this.disposed) {
      return;
    }
    if (this.terminal.element?.parentElement === host) {
      // Re-assert ownership: the property is the host's debug/E2E reference,
      // and this instance still owns the element inside it.
      this.setHostReference(host);
      return;
    }
    if (this.terminal.element) {
      // xterm.open() is one-shot: once the terminal has been opened it returns
      // early when called again. Reparent the existing DOM tree so detach /
      // reattach preserves both the buffer and the renderer state.
      this.releaseHostReference();
      host.appendChild(this.terminal.element);
      this.setHostReference(host);
      this.terminal.refresh(0, this.terminal.rows - 1);
      return;
    }
    this.terminal.open(host);
    // Expose the Terminal instance on the container element so E2E tests can
    // read the buffer (canvas/webgl renderers don't put text in the DOM).
    this.setHostReference(host);
    this.remeasureOnFontLoad();
    this.ensureLinkTouchHandler();
  }

  private setHostReference(host: HTMLElement): void {
    (host as XtermMountElement).xtermInstance = this.terminal;
    this.mountHost = host;
  }

  /**
   * Drop the debug/E2E reference only when it still names *this* Terminal.
   *
   * A host can be reused by a replacement renderer before the old instance is
   * disposed; an unconditional `delete` would then hide the live reference and
   * leave a stale one unaccounted for (#2879).
   */
  private releaseHostReference(): void {
    for (const host of [this.mountHost, this.terminal.element?.parentElement ?? null]) {
      const mount = host as XtermMountElement | null;
      if (mount && mount.xtermInstance === this.terminal) {
        delete mount.xtermInstance;
      }
    }
    this.mountHost = null;
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
      this.fontSizeCallback('font-load');
    });
  }

  /** Detach from a container — preserve JS buffer; drop stale DOM nodes. */
  unmount(): void {
    if (this.disposed) {
      return;
    }
    const element = this.terminal.element;
    // Release before remove(): the element's parent is how the reference is
    // found when no host was recorded (or was externally moved).
    this.releaseHostReference();
    element?.remove();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.releaseHostReference();
    this.linkTouchDisposable?.dispose();
    this.linkTouchDisposable = null;
    this.linkMatchers.clear();
    this.renderer.dispose();
    // xterm's own addon manager disposes every registered addon exactly once.
    this.terminal.dispose();
  }

  // ── Port: ordered mutation ──────────────────────────────────────────────

  write(
    data: string | Uint8Array,
    onParsed?: () => void,
    origin: TerminalWriteOrigin = { source: 'live' },
  ): void {
    this.writeOrigin = origin;
    this.terminal.write(data, () => {
      // Parsing of this write is complete; anything after it is a new origin.
      this.writeOrigin = { source: 'live' };
      onParsed?.();
    });
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  // ── Port: read models and events ────────────────────────────────────────

  readBuffer(): TerminalBufferSnapshot {
    return readBufferSnapshot(this.terminal);
  }

  readModes(): TerminalModeSnapshot {
    return readModeSnapshot(this.terminal);
  }

  cellDimensions(): TerminalCellSize {
    return cellSizeOf(this.terminal);
  }

  measureCell(): PixelSize | null {
    return measuredCellDimensionsOf(this.terminal);
  }

  onData(listener: (data: string) => void): TerminalDisposable {
    return this.terminal.onData(listener);
  }

  onBinary(listener: (data: string) => void): TerminalDisposable {
    return this.terminal.onBinary(listener);
  }

  onCursorMove(listener: () => void): TerminalDisposable {
    return this.terminal.onCursorMove(listener);
  }

  onRender(listener: () => void): TerminalDisposable {
    return this.terminal.onRender(listener);
  }

  onScroll(listener: () => void): TerminalDisposable {
    return this.terminal.onScroll(listener);
  }

  onBufferChange(listener: () => void): TerminalDisposable {
    return this.terminal.buffer.onBufferChange(() => listener());
  }

  onResize(listener: () => void): TerminalDisposable {
    return this.terminal.onResize(listener);
  }

  onTitleChange(listener: (title: string) => void): TerminalDisposable {
    return this.terminal.onTitleChange(listener);
  }

  /**
   * Register a link matcher over logical buffer lines.
   *
   * The matcher sees text only; this method reads the physical lines (joining
   * wrapped continuations), maps UTF-16 offsets to the cells xterm is drawing
   * — including wide and combining characters — and hands xterm a range. A
   * matcher that returns an out-of-range span is ignored rather than clamped,
   * so a stale match cannot underline the wrong cells.
   */
  registerLinkMatcher(matcher: TerminalLinkMatcher): TerminalDisposable {
    this.linkMatchers.set(matcher, (this.linkMatchers.get(matcher) ?? 0) + 1);
    this.ensureLinkTouchHandler();
    const provider = this.terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) => {
        const line = readLogicalLine(this.terminal, bufferLineNumber);
        if (line.text.length === 0) {
          callback(undefined);
          return;
        }
        const links: ILink[] = mapLineLinks(line, matcher({ text: line.text }))
          .map((link) => ({
            text: link.text,
            range: { start: link.start, end: link.end },
            activate: link.activate,
          }));
        callback(links.length > 0 ? links : undefined);
      },
    });
    return {
      dispose: () => {
        provider.dispose();
        const count = this.linkMatchers.get(matcher) ?? 0;
        if (count <= 1) {
          this.linkMatchers.delete(matcher);
        } else {
          this.linkMatchers.set(matcher, count - 1);
        }
        this.releaseLinkTouchHandlerIfIdle();
      },
    };
  }

  /**
   * Install the tap → link activation listeners (#3187).
   *
   * A tap is a single finger that moved less than the shell's own 10px
   * gesture slop and lifted within 500ms. Longer presses (the direction pad)
   * and drags (scroll/selection) are left to their owners. The handler never
   * writes to the PTY: it asks the registered Product matchers about the drawn
   * cell and invokes the same activation the mouse linkifier would.
   */
  private ensureLinkTouchHandler(): void {
    if (this.linkTouchDisposable || this.linkMatchers.size === 0) {
      return;
    }
    const element = this.terminal.element;
    if (!element) {
      return;
    }
    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        this.tapCandidate = null;
        return;
      }
      const touch = event.touches[0]!;
      this.tapCandidate = {
        identifier: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        moved: false,
        startedAt: Date.now(),
      };
    };
    const onMove = (event: TouchEvent) => {
      const candidate = this.tapCandidate;
      if (!candidate) {
        return;
      }
      const touch = Array.from(event.touches).find(
        (item) => item.identifier === candidate.identifier,
      );
      if (!touch) {
        return;
      }
      if (Math.hypot(touch.clientX - candidate.x, touch.clientY - candidate.y) > 10) {
        candidate.moved = true;
      }
    };
    const onEnd = (event: TouchEvent) => {
      const candidate = this.tapCandidate;
      this.tapCandidate = null;
      if (!candidate) {
        return;
      }
      const touch = Array.from(event.changedTouches).find(
        (item) => item.identifier === candidate.identifier,
      );
      if (
        !touch ||
        candidate.moved ||
        Date.now() - candidate.startedAt > 500
      ) {
        return;
      }
      this.activateLinkAtPoint(touch.clientX, touch.clientY);
    };
    const onCancel = () => {
      this.tapCandidate = null;
    };
    element.addEventListener('touchstart', onStart, { passive: true });
    element.addEventListener('touchmove', onMove, { passive: true });
    element.addEventListener('touchend', onEnd, { passive: true });
    element.addEventListener('touchcancel', onCancel, { passive: true });
    this.linkTouchDisposable = {
      dispose: () => {
        element.removeEventListener('touchstart', onStart);
        element.removeEventListener('touchmove', onMove);
        element.removeEventListener('touchend', onEnd);
        element.removeEventListener('touchcancel', onCancel);
      },
    };
  }

  private releaseLinkTouchHandlerIfIdle(): void {
    if (this.linkMatchers.size > 0) {
      return;
    }
    this.linkTouchDisposable?.dispose();
    this.linkTouchDisposable = null;
    this.tapCandidate = null;
  }

  /** Activate the Product link drawn at a client point, if any (#3187). */
  private activateLinkAtPoint(clientX: number, clientY: number): boolean {
    const point = logicalLinePoint(this.terminal, clientX, clientY);
    if (!point || point.offset < 0) {
      return false;
    }
    for (const matcher of this.linkMatchers.keys()) {
      const hit = matcher({ text: point.line.text }).find(
        (range) => point.offset >= range.startIndex && point.offset < range.endIndex,
      );
      if (hit) {
        hit.activate();
        return true;
      }
    }
    return false;
  }

  /**
   * Install the OSC 52 / OSC 5522 parser handlers (#2598).
   *
   * Private mode 5522 is intercepted ahead of xterm's DECSET/DECRST fallback —
   * the handler returns `false` afterwards so every other mode in the same
   * sequence is still applied. DECRQM is answered here for 5522 only, because
   * xterm would otherwise answer "not recognized" for a mode it does not own.
   */
  registerClipboardHost(host: TerminalClipboardHost): TerminalDisposable {
    this.clipboardDisposable?.dispose();
    const parser = this.terminal.parser;
    const origin = (): TerminalWriteOrigin => this.writeOrigin;
    const applyMode = (params: (number | number[])[], enabled: boolean): boolean => {
      if (params.some((param) => param === 5522)) {
        host.setPasteEventMode(enabled, origin());
      }
      return false;
    };
    const disposables: { dispose(): void }[] = [
      parser.registerOscHandler(52, (data) => host.handleOsc52(data, origin())),
      parser.registerOscHandler(5522, (data) => host.handleOsc5522(data, origin())),
      parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => applyMode(params, true)),
      parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => applyMode(params, false)),
      parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, (params) => {
        if (params[0] !== 5522) { return false; }
        host.reportModeQuery();
        return true;
      }),
    ];
    const disposable: TerminalDisposable = {
      dispose: () => {
        for (const item of disposables) { item.dispose(); }
        if (this.clipboardDisposable === disposable) { this.clipboardDisposable = null; }
      },
    };
    this.clipboardDisposable = disposable;
    return disposable;
  }

  // ── Port: interaction and bounded configuration ─────────────────────────

  input(data: string, wasUserInput = true): void {
    this.terminal.input(data, wasUserInput);
  }

  paste(text: string): void {
    this.terminal.paste(text);
  }

  clear(): void {
    this.terminal.clear();
  }

  focus(): void {
    this.terminal.focus();
  }

  setInputEnabled(enabled: boolean): void {
    this.terminal.options.disableStdin = !enabled;
  }

  scrollToBottom(): void {
    this.terminal.scrollToBottom();
  }

  scrollPages(pages: number): void {
    this.terminal.scrollPages(pages);
  }

  scrollLines(lines: number): void {
    this.terminal.scrollLines(lines);
  }

  attachCustomWheelHandler(handler: (event: WheelEvent) => boolean): void {
    this.terminal.attachCustomWheelEventHandler(handler);
  }

  /**
   * Apply a font size for fixed-column fitting and return the cell xterm
   * measured at it. `refresh` forces the re-measure immediately; without it
   * the caller would read the previous font's cell.
   */
  setFontSize(size: number): TerminalCellSize {
    this.terminal.options.fontSize = size;
    this.terminal.refresh(0, Math.max(0, this.terminal.rows - 1));
    return this.cellDimensions();
  }
}

/** The xterm factory used by the canonical fixture, which has no transport. */
export function createTerminalEmulator(options: XtermEmulatorOptions): TerminalEmulator {
  return new XtermEmulator(options);
}
