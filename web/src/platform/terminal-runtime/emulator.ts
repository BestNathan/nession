import type { PixelSize } from './grid';

/**
 * The business-neutral terminal emulator port (#2581).
 *
 * `platform/terminal-runtime/xterm/` owns the only production `@xterm/xterm`
 * `Terminal` instance and implements this port (`XtermEmulator`). Product/UI
 * code consumes this surface — buffer/mode read models, typed disposables,
 * bounded font configuration and link matching — and never imports xterm or
 * reads its private `_core`.
 *
 * The port deliberately has no "raw terminal" member. `write`/`resize` are
 * present because the ordered writer (`SerializedTerminalWriter`) implements
 * `TerminalWriteTarget` against this port; nothing else may call them outside
 * the writer's FIFO.
 */

/** A disposable owned by the emulator (xterm's own `IDisposable` shape). */
export interface TerminalDisposable {
  dispose(): void;
}

/** The active buffer's stable read model at one moment. */
export interface TerminalBufferSnapshot {
  readonly type: 'normal' | 'alternate';
  readonly length: number;
  readonly viewportY: number;
  readonly cursorX: number;
  readonly cursorY: number;
}

export type TerminalMouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

/** The terminal modes an interaction adapter must read from the emulator. */
export interface TerminalModeSnapshot {
  readonly applicationCursorKeysMode: boolean;
  readonly bracketedPasteMode: boolean;
  readonly mouseTrackingMode: TerminalMouseTrackingMode;
  readonly alternateBuffer: boolean;
}

export interface TerminalCellSize {
  readonly width: number;
  readonly height: number;
}

/**
 * One logical buffer line: a physical line plus its wrapped continuations,
 * with trailing empty cells trimmed. `text` is what a feature matcher reads.
 */
export interface TerminalLinkLine {
  readonly text: string;
}

/**
 * A match inside {@link TerminalLinkLine.text}, as UTF-16 offsets
 * `[startIndex, endIndex)`. The emulator maps these offsets to buffer cells,
 * so the feature never does cell arithmetic.
 */
export interface TerminalLinkRange {
  readonly startIndex: number;
  readonly endIndex: number;
  activate(): void;
}

export type TerminalLinkMatcher = (line: TerminalLinkLine) => readonly TerminalLinkRange[];

/**
 * The emulator contract. `mount`/`unmount` reparent without destroying the
 * buffer; `dispose` releases everything exactly once.
 */
export interface TerminalEmulator {
  readonly element: HTMLElement | null;
  readonly cols: number;
  readonly rows: number;

  mount(host: HTMLElement): void;
  unmount(): void;
  dispose(): void;

  /** Ordered writer target — callers must be the serialized writer. */
  write(data: string | Uint8Array, onParsed?: () => void): void;
  /** Ordered writer target — callers must be the serialized writer. */
  resize(cols: number, rows: number): void;

  readBuffer(): TerminalBufferSnapshot;
  readModes(): TerminalModeSnapshot;
  cellDimensions(): TerminalCellSize;

  onData(listener: (data: string) => void): TerminalDisposable;
  /** Bytes xterm received that are not valid UTF-8 text (`onBinary`). */
  onBinary(listener: (data: string) => void): TerminalDisposable;
  onCursorMove(listener: () => void): TerminalDisposable;
  onRender(listener: () => void): TerminalDisposable;
  onScroll(listener: () => void): TerminalDisposable;
  onResize(listener: () => void): TerminalDisposable;
  onTitleChange(listener: (title: string) => void): TerminalDisposable;

  /**
   * Register a link matcher. The emulator reads logical lines (joined across
   * wrapped continuations) and maps UTF-16 offsets to buffer cells; the
   * matcher owns recognition and activation only.
   */
  registerLinkMatcher(matcher: TerminalLinkMatcher): TerminalDisposable;

  input(data: string, wasUserInput?: boolean): void;
  paste(text: string): void;
  clear(): void;
  focus(): void;
  setInputEnabled(enabled: boolean): void;
  scrollToBottom(): void;
  scrollPages(pages: number): void;
  scrollLines(lines: number): void;
  attachCustomWheelHandler(handler: (event: WheelEvent) => boolean): void;

  /** Apply a fixed-column font fit and return the cell xterm measured. */
  setFontSize(size: number): TerminalCellSize;
  /** The cell xterm has measured at the current font, or null before layout. */
  measureCell(): PixelSize | null;
}
