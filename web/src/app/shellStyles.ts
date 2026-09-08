/**
 * Session-first shell chrome — token vars only (styling-convergence step 7).
 * Web: --shell-icon-button-size → control-lg (36px). App: remapped under
 * [data-experience="app"] → control-md (44px).
 */

export const shellMotionClass =
  'transition-colors duration-[var(--motion-shell-duration)] ease-[var(--motion-shell-ease)]';

export const shellIconButtonClass = `size-[length:var(--shell-icon-button-size)] shrink-0 ${shellMotionClass}`;

/** Compact row actions (filter chips, sort) on web desktop — control-md band. */
export const shellRowControlMinClass = 'min-h-[length:var(--control-md)]';
