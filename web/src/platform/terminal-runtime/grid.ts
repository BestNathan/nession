import type { Terminal } from '@xterm/xterm';

/** A width/height pair, in CSS pixels. */
export interface PixelSize {
  width: number;
  height: number;
}

/** A terminal grid. */
export interface Grid {
  cols: number;
  rows: number;
}

/** What to assume about the cell before xterm's renderer has measured one. */
export const FALLBACK_CELL: PixelSize = { width: 8, height: 16 };

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
 * grid from the same numbers xterm will use to draw it. A caller that derived
 * its own cell width could ask for a grid xterm then renders at a different
 * size — which is one half of #1092.
 *
 * The access is a private field and *throws* until the renderer has finished
 * its first layout pass (right after `open()`, under a StrictMode remount, or
 * while WebGL is still initialising), so it is guarded. `null` means "not
 * measured" and nothing else — `cellDimensionsOf` is the variant that answers
 * with `FALLBACK_CELL` for callers that cannot wait.
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
 * For a caller that must produce *a* number now — `ResizeController` sizes a
 * live terminal whose container has already changed. A caller that can wait
 * should use the measurement directly: fitting a grid to the fallback cell
 * asks for the wrong number of columns, and if nothing resizes the container
 * afterwards nothing corrects it.
 */
export function cellDimensionsOf(terminal: Terminal): PixelSize {
  return measuredCellDimensionsOf(terminal) ?? FALLBACK_CELL;
}

/**
 * The grid that fits in `size`, or `null` when the result would be degenerate.
 *
 * **`size` must be the content box** — the space left after padding. xterm
 * sizes its screen to `cols * cell.width`, so a grid computed from a padded box
 * draws wider than the element holding it. That is #1092 exactly: the canonical
 * fixture fitted against a box that still included the `--terminal-pad-x`
 * inset, and the terminal ran 11px past it — 14px of inset on the left, 3px on
 * the right, in every App baseline. A `ResizeObserverEntry.contentRect` is a
 * content box by definition, which is why both callers measure that way.
 *
 * `null` is xterm's own floor rather than an error: it renders nothing useful
 * below 2x2, so every caller skips instead of applying.
 */
export function gridFor(size: PixelSize, cell: PixelSize): Grid | null {
  if (cell.width <= 0 || cell.height <= 0) {
    return null;
  }
  const cols = Math.max(1, Math.floor(size.width / cell.width));
  const rows = Math.max(1, Math.floor(size.height / cell.height));
  if (cols < 2 || rows < 2) {
    return null;
  }
  return { cols, rows };
}
