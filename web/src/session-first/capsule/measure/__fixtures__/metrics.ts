import type { ComposerMetrics } from '@/session-first/capsule/measure/types';

/** Web experience fixture — mirrors legacy capsule rhythm before token cutover. */
export const WEB_COMPOSER_METRICS: ComposerMetrics = {
  textLineHeight: 20,
  controlHeight: 32,
  fieldPadY: 12,
  singleHeightTolerance: 2,
  maxLines: 5,
};

/** App experience fixture — larger touch targets and row rhythm. */
export const APP_COMPOSER_METRICS: ComposerMetrics = {
  textLineHeight: 48,
  controlHeight: 44,
  fieldPadY: 16,
  singleHeightTolerance: 2,
  maxLines: 5,
};
