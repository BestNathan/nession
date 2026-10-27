import type { PixelSize } from './grid';

/**
 * Fixed-column terminal sizing (#2487).
 *
 * The column count is canonical and never derived from a viewport width. What
 * adapts is the **font size**: a wider viewport may show the configured Web
 * maximum, a narrower one shrinks the font until exactly `cols` fit, and a
 * phone uses the same columns at a smaller measured cell. Rows remain a
 * function of usable height.
 *
 * All arithmetic here uses the cell metrics xterm actually reports. The
 * renderer measures a cell for the current font, so the fit probes it rather
 * than assuming a glyph's width from its font size (the prototype's
 * `fontSize × 0.6` approximation is not production truth).
 */

/**
 * The smallest font the fixed-column fit may choose (#2487).
 *
 * This is below the manual zoom floor (8 px): a phone must be able to show the
 * canonical 88 columns in its content box, which lands near 6.9 px at 393 px.
 * The prototype exposes this readability trade-off rather than hiding it; the
 * canonical column count can be lowered at build time when the selected count
 * cannot meet the accessibility policy.
 */
export const MIN_TERMINAL_FIT_FONT_SIZE = 6;

/** xterm's floor: below 2x2 it renders nothing useful. */
const MIN_TERMINAL_ROWS = 2;
const MIN_TERMINAL_COLS = 2;
const FONT_STEP = 0.1;
const MAX_PROBES = 4;

export interface FontFit {
  fontSize: number;
  cell: PixelSize;
  /** `cols × cell.width` — the terminal's content width at this font. */
  contentWidth: number;
  /** False when even the minimum font is wider than the available width. */
  fits: boolean;
}

export interface FitFontOptions {
  cols: number;
  /** The content box available to the terminal, in CSS pixels. */
  availableWidth: number;
  minFontSize: number;
  maxFontSize: number;
  /**
   * Measure the current cell after xterm has been asked to render at
   * `fontSize`. `null` means the renderer has not measured a cell yet.
   */
  measureCell: (fontSize: number) => PixelSize | null;
}

function usable(cell: PixelSize | null): cell is PixelSize {
  return cell !== null && cell.width > 0 && cell.height > 0;
}

function contentWidth(cols: number, cell: PixelSize): number {
  return cols * cell.width;
}

function roundDownFont(value: number): number {
  return Math.max(0, Math.floor(value / FONT_STEP) * FONT_STEP);
}

/**
 * The largest font, at or below `maxFontSize`, whose `cols` fit in
 * `availableWidth`.
 *
 * Returns `null` only while the renderer cannot measure a cell at all. When
 * even `minFontSize` does not fit, the fit still returns the minimum font with
 * `fits: false`: the caller keeps the canonical columns and owns the explicit
 * overflow/accessibility fallback rather than silently dropping columns.
 *
 * The first probe is the maximum font, which is the common desktop answer. A
 * narrower viewport is solved from the same measurement by scaling the font
 * linearly — cell width scales with the font for a fixed family — and then
 * confirmed against a second real measurement. At most four probes run.
 */
export function fitFontToColumns(options: FitFontOptions): FontFit | null {
  const { cols, availableWidth, minFontSize, maxFontSize, measureCell } = options;
  if (cols < MIN_TERMINAL_COLS || availableWidth <= 0) {
    return null;
  }
  if (!Number.isFinite(minFontSize) || !Number.isFinite(maxFontSize)
    || minFontSize <= 0 || maxFontSize < minFontSize) {
    return null;
  }

  let fontSize = maxFontSize;
  let cell = measureCell(fontSize);
  if (!usable(cell)) {
    return null;
  }
  if (contentWidth(cols, cell) <= availableWidth) {
    return {
      fontSize,
      cell,
      contentWidth: contentWidth(cols, cell),
      fits: true,
    };
  }

  for (let probe = 0; probe < MAX_PROBES; probe += 1) {
    const width = contentWidth(cols, cell);
    const scaled = roundDownFont(fontSize * (availableWidth / width));
    const next = Math.max(minFontSize, Math.min(maxFontSize, scaled));
    if (Math.abs(next - fontSize) < FONT_STEP / 2) {
      break;
    }
    fontSize = next;
    cell = measureCell(fontSize);
    if (!usable(cell)) {
      return null;
    }
    if (contentWidth(cols, cell) <= availableWidth) {
      return {
        fontSize,
        cell,
        contentWidth: contentWidth(cols, cell),
        fits: true,
      };
    }
  }

  // The minimum font is the lower bound. Even when it is too wide, the caller
  // gets the honest answer instead of a different column count.
  if (fontSize > minFontSize) {
    fontSize = minFontSize;
    cell = measureCell(fontSize);
    if (!usable(cell)) {
      return null;
    }
  }
  const width = contentWidth(cols, cell);
  return {
    fontSize,
    cell,
    contentWidth: width,
    fits: width <= availableWidth,
  };
}

/**
 * Rows that fit `availableHeight` at the measured cell height.
 *
 * `null` below the renderer's usable floor; nothing is resized then.
 */
export function rowsForHeight(
  availableHeight: number,
  cellHeight: number,
  minRows: number = MIN_TERMINAL_ROWS,
): number | null {
  if (availableHeight <= 0 || cellHeight <= 0 || !Number.isFinite(availableHeight)
    || !Number.isFinite(cellHeight)) {
    return null;
  }
  const rows = Math.floor(availableHeight / cellHeight);
  return rows >= minRows ? rows : null;
}
