import type { Terminal } from '@xterm/xterm';
import { FALLBACK_CELL, type PixelSize } from '../grid';
import type {
  TerminalBufferSnapshot,
  TerminalCellSize,
  TerminalModeSnapshot,
  TerminalMouseTrackingMode,
} from '../emulator';

/**
 * The single compatibility adapter for xterm private/read-model access (#2581).
 *
 * Everything the engine reports upwards — measured cells, buffer position,
 * application modes, and the logical lines link matching runs on — is read
 * here. This file is the ONE place allowed to touch `_core`; the
 * `nession/no-direct-xterm` rule enforces that, and its negative fixture proves
 * the rule rejects the same access anywhere else.
 */

/** xterm's render service, read structurally — these are private fields. */
interface TerminalInternals {
  _core?: {
    _renderService?: {
      dimensions?: { css?: { cell?: PixelSize } };
    };
  };
}

/**
 * The cell size xterm is rendering with.
 *
 * Read from the render service rather than measured, so every caller computes a
 * grid from the same numbers xterm will use to draw it. The access *throws*
 * until the renderer has finished its first layout pass (right after `open()`,
 * under a StrictMode remount, or while WebGL is still initialising), so it is
 * guarded. `null` means "not measured" and nothing else.
 */
export function measuredCellDimensionsOf(terminal: Terminal): PixelSize | null {
  try {
    const rs = (terminal as unknown as TerminalInternals)._core?._renderService;
    const cell = rs?.dimensions?.css?.cell;
    if (!cell || !cell.width || !cell.height) {
      return null;
    }
    return { width: cell.width, height: cell.height };
  } catch {
    return null;
  }
}

/**
 * `measuredCellDimensionsOf` with a conservative fallback.
 *
 * For a caller that must produce *a* number now. A caller that can wait should
 * use the measurement directly: fitting a grid to the fallback cell asks for
 * the wrong number of columns, and if nothing resizes the container afterwards
 * nothing corrects it.
 */
export function cellDimensionsOf(terminal: Terminal): PixelSize {
  return measuredCellDimensionsOf(terminal) ?? FALLBACK_CELL;
}

/** The measured cell as the emulator port's `TerminalCellSize`. */
export function cellSizeOf(terminal: Terminal): TerminalCellSize {
  const cell = cellDimensionsOf(terminal);
  return { width: cell.width, height: cell.height };
}

export function readBufferSnapshot(terminal: Terminal): TerminalBufferSnapshot {
  const buffer = terminal.buffer.active;
  return {
    type: buffer.type,
    length: buffer.length,
    viewportY: buffer.viewportY,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
  };
}

const MOUSE_TRACKING_MODES: ReadonlySet<string> = new Set<string>([
  'none', 'x10', 'vt200', 'drag', 'any',
]);

/** The application modes surfaced to interaction adapters. */
export function readModeSnapshot(terminal: Terminal): TerminalModeSnapshot {
  const raw = terminal.modes.mouseTrackingMode as string;
  const mouseTrackingMode = (MOUSE_TRACKING_MODES.has(raw) ? raw : 'none') as TerminalMouseTrackingMode;
  return {
    applicationCursorKeysMode: terminal.modes.applicationCursorKeysMode,
    bracketedPasteMode: terminal.modes.bracketedPasteMode,
    mouseTrackingMode,
    alternateBuffer: terminal.buffer.active.type === 'alternate',
  };
}

/** Where one UTF-16 code unit of a logical line lives in the buffer. */
export interface LogicalLineCell {
  /** Absolute buffer line (1-based), as xterm's link provider addresses it. */
  readonly bufferLine: number;
  /** 0-based cell column of the character's first cell. */
  readonly cell: number;
  /** The cell width xterm reports for the character (1 or 2). */
  readonly width: number;
}

/** A physical line plus its wrapped continuations, trimmed at the right. */
export interface LogicalTerminalLine {
  readonly text: string;
  /**
   * One entry per UTF-16 code unit of {@link text}. A wide character occupies
   * two entries with the same cell; a combining sequence keeps all its code
   * units on the cell xterm stores them in.
   */
  readonly cells: readonly LogicalLineCell[];
}

/**
 * Read the logical line beginning at `bufferLineNumber` (1-based).
 *
 * A line whose first physical line `isWrapped` is a continuation, not the start
 * of a logical line: answering there would duplicate a match on every visual
 * row. Trailing empty cells are trimmed exactly like
 * `IBufferLine.translateToString(true)` so a match does not depend on terminal
 * width.
 */
export function readLogicalLine(terminal: Terminal, bufferLineNumber: number): LogicalTerminalLine {
  const buffer = terminal.buffer.active;
  const startIndex = bufferLineNumber - 1;
  const first = buffer.getLine(startIndex);
  if (!first || first.isWrapped) {
    return { text: '', cells: [] };
  }

  let text = '';
  const cells: LogicalLineCell[] = [];
  let index = startIndex;
  let line = first;
  // A physical line cannot hold more cells than the terminal has columns; a
  // line array may not shrink on resize, so the columns cap keeps us to what
  // is drawn.
  const width = terminal.cols;

  while (line) {
    const length = Math.min(line.length, width);
    for (let cell = 0; cell < length; cell += 1) {
      const bufferCell = line.getCell(cell);
      if (!bufferCell) { break; }
      const cellWidth = bufferCell.getWidth();
      // A zero-width cell is the trailing half of a wide character, which the
      // cell it belongs to already represents.
      if (cellWidth === 0) { continue; }
      const chars = bufferCell.getChars() || ' ';
      text += chars;
      for (let unit = 0; unit < chars.length; unit += 1) {
        cells.push({ bufferLine: index + 1, cell, width: cellWidth });
      }
    }
    const next = buffer.getLine(index + 1);
    if (!next || !next.isWrapped) { break; }
    index += 1;
    line = next;
  }

  while (text.endsWith(' ')) {
    text = text.slice(0, -1);
    cells.pop();
  }

  return { text, cells };
}
