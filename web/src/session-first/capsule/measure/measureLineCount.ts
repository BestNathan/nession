import type { ComposerMetrics } from '@/session-first/capsule/measure/types';

/**
 * Map textarea value + measured scrollHeight to composer line count.
 * Empty always stays 1 (flat), even when mobile browsers inflate scrollHeight.
 */
export function measureLineCount(
  value: string,
  scrollHeight: number,
  metrics: ComposerMetrics,
): number {
  if (value.length === 0) {
    return 1;
  }

  const fromBreaks = Math.max(1, value.split('\n').length);
  const hasHardBreak = value.includes('\n');
  if (
    !hasHardBreak &&
    scrollHeight <= metrics.controlHeight + metrics.singleHeightTolerance
  ) {
    return 1;
  }

  const fromHeight = Math.max(
    1,
    Math.ceil(
      Math.max(0, scrollHeight - metrics.fieldPadY) / metrics.textLineHeight,
    ),
  );
  return Math.max(fromBreaks, fromHeight);
}
