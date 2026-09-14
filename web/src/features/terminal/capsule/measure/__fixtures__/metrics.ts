import type { ComposerMetrics } from '@/features/terminal/capsule/measure/types';

/** Web experience fixture — mirrors legacy capsule rhythm before token cutover. */
export const WEB_COMPOSER_METRICS: ComposerMetrics = {
  textLineHeight: 20,
  controlHeight: 32,
  fieldPadY: 12,
  singleHeightTolerance: 2,
  maxLines: 5,
};
