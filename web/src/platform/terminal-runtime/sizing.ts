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

/** xterm's floor: below 2x2 it renders nothing useful. */
const MIN_TERMINAL_ROWS = 2;
const MIN_TERMINAL_COLS = 2;
/**
 * The numerical lower bound of the font-size search, **not** a readability or
 * product minimum (#2592).
 *
 * There is no Nession-defined minimum font size on App/mobile: the chosen size
 * is whatever the measured cell needs for the fixed columns to fit the actual
 * content box, including values below 6 px. A positive bound only keeps the
 * bisection well-defined; a renderer that cannot measure a positive cell at a
 * candidate reports it as unusable rather than being counted as a fit.
 */
const FIT_SEARCH_FLOOR = 0.1;
/** Font-size resolution of the fit. Device-pixel quantization is coarser. */
const FIT_PRECISION = 0.05;
const MAX_PROBES = 16;

export interface FontFit {
  fontSize: number;
  cell: PixelSize;
  /** `cols × cell.width` — the terminal's content width at this font. */
  contentWidth: number;
  /**
   * Whether the measured grid fits the content box. `false` is an honest
   * renderer-limitation answer, never a different column count or a fabricated
   * minimum-size pass.
   */
  fits: boolean;
}

export interface FitFontOptions {
  cols: number;
  /** The content box available to the terminal, in CSS pixels. */
  availableWidth: number;
  /** The largest candidate, and the first probe. */
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

function roundedFont(value: number): number {
  return Math.round(value / FIT_PRECISION) * FIT_PRECISION;
}

function measured(measureCell: FitFontOptions['measureCell'], fontSize: number): PixelSize | null {
  const cell = measureCell(fontSize);
  return usable(cell) ? cell : null;
}

/**
 * The largest font, at or below `maxFontSize`, whose measured `cols` fit
 * `availableWidth`.
 *
 * There is **no application-level minimum font size** (#2592): the search runs
 * below 6 px whenever the content box and the fixed columns require it. The
 * only lower bound is the numerical `FIT_SEARCH_FLOOR`; a candidate whose cell
 * cannot be measured positive is unusable, not a fit.
 *
 * The first probe is the maximum font, which is the common desktop answer.
 * Otherwise the font is found by bisection over real measurements: device-pixel
 * quantization makes the cell width a step function of the font size, so a
 * linear `fontSize × constant` guess (or a single linear probe) can land on the
 * wrong side of a step. The final chosen size is measured once more, so the
 * renderer is left drawing the returned grid.
 *
 * Returns `null` only while the renderer cannot measure a cell at all. When no
 * tested size fits, the smallest **measured** cell is returned with
 * `fits: false`; a zero or invalid cell is never reported as a fit.
 */
export function fitFontToColumns(options: FitFontOptions): FontFit | null {
  const { cols, availableWidth, maxFontSize, measureCell } = options;
  if (!Number.isFinite(cols) || cols < MIN_TERMINAL_COLS
    || !Number.isFinite(availableWidth) || availableWidth <= 0) {
    return null;
  }
  if (!Number.isFinite(maxFontSize) || maxFontSize <= 0) {
    return null;
  }

  const atMax = measured(measureCell, maxFontSize);
  if (atMax === null) {
    return null;
  }
  const maxWidth = contentWidth(cols, atMax);
  if (maxWidth <= availableWidth) {
    return { fontSize: maxFontSize, cell: atMax, contentWidth: maxWidth, fits: true };
  }

  // Bisect between a not-fitting upper bound and a fitting lower bound.
  let low = FIT_SEARCH_FLOOR;
  let high = maxFontSize;
  let best: FontFit | null = null;
  let smallest: FontFit | null = null;
  for (let probe = 0; probe < MAX_PROBES && high - low > FIT_PRECISION; probe += 1) {
    const size = roundedFont((low + high) / 2);
    if (size <= low || size >= high) {
      break;
    }
    const cell = measured(measureCell, size);
    if (cell === null) {
      // Not a usable grid at this size: keep searching above it.
      high = size;
      continue;
    }
    const width = contentWidth(cols, cell);
    const candidate: FontFit = {
      fontSize: size,
      cell,
      contentWidth: width,
      fits: width <= availableWidth,
    };
    if (smallest === null || size < smallest.fontSize) {
      smallest = candidate;
    }
    if (candidate.fits) {
      low = size;
      best = candidate;
    } else {
      high = size;
    }
  }

  const chosen = best ?? smallest;
  if (chosen === null) {
    return null;
  }
  // Leave the renderer at the size being returned, and report that size's
  // actual cell — the bisection's last probe is not necessarily the answer.
  const finalCell = measured(measureCell, chosen.fontSize);
  if (finalCell === null) {
    return null;
  }
  const finalWidth = contentWidth(cols, finalCell);
  return {
    fontSize: chosen.fontSize,
    cell: finalCell,
    contentWidth: finalWidth,
    fits: finalWidth <= availableWidth,
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
