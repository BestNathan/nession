import type { ComposerMetrics } from '@/session-first/capsule/measure/types';

function parsePx(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }
  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) ? value : fallback;
}

/** Read resolved composer metrics from computed CSS custom properties. */
export function readComposerMetrics(scope: HTMLElement): ComposerMetrics {
  const styles = getComputedStyle(scope);
  const textLineHeight = parsePx(styles.getPropertyValue('--composer-line-height'), 20);
  const controlHeight = parsePx(styles.getPropertyValue('--control-md'), 32);
  const fieldPadY = parsePx(styles.getPropertyValue('--panel-padding'), 12) * 2;
  const maxLines = Number.parseInt(styles.getPropertyValue('--composer-max-lines'), 10);

  return {
    textLineHeight,
    controlHeight,
    fieldPadY,
    singleHeightTolerance: 2,
    maxLines: Number.isFinite(maxLines) && maxLines > 0 ? maxLines : 5,
  };
}

/** Mirror element may expose a different resolved line-height than token defaults. */
export function readComposerMetricsFromField(
  scope: HTMLElement,
  field: HTMLElement,
): ComposerMetrics {
  const base = readComposerMetrics(scope);
  const fieldStyles = getComputedStyle(field);
  const resolvedLineHeight = parsePx(fieldStyles.lineHeight, base.textLineHeight);
  const padTop = parsePx(fieldStyles.paddingTop, base.fieldPadY / 2);
  const padBottom = parsePx(fieldStyles.paddingBottom, base.fieldPadY / 2);

  return {
    ...base,
    textLineHeight: resolvedLineHeight,
    fieldPadY: padTop + padBottom,
  };
}
