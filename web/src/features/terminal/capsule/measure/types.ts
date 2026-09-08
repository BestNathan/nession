/** Resolved composer metrics — numbers come from computed token vars, not TS constants. */
export interface ComposerMetrics {
  /** CSS line-height used for soft-wrap line counting. */
  textLineHeight: number;
  /** Single-line control band (--control-md). */
  controlHeight: number;
  /** Field vertical padding total (top + bottom). */
  fieldPadY: number;
  /** Subpixel slack before counting an extra soft-wrap line. */
  singleHeightTolerance: number;
  maxLines: number;
}

export function maxFieldHeightPx(metrics: ComposerMetrics): number {
  return metrics.textLineHeight * metrics.maxLines + metrics.fieldPadY;
}
