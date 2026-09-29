/**
 * Session-first shell chrome — token vars only (styling-convergence step 7).
 * Web: --shell-icon-button-size → control-lg (36px). App: remapped under
 * [data-experience="app"] → control-md (44px).
 */

export const shellMotionClass =
  'transition-colors duration-[var(--motion-shell-duration)] ease-[var(--motion-shell-ease)]';

/**
 * The shell's icon-only button box. The class owns centering as well as size:
 * consumers through the Button primitive already carried `inline-flex
 * items-center justify-center` from the base class, but a raw `<button>` got
 * only the size here and rendered its glyph flush-left inside the box
 * (measured: 16px glyph at x+0 of a 36px button, 10px off center).
 */
export const shellIconButtonClass = `inline-flex items-center justify-center size-[length:var(--shell-icon-button-size)] shrink-0 ${shellMotionClass}`;

/** Compact row actions (filter chips, sort) on web desktop — control-md band. */
export const shellRowControlMinClass = 'min-h-[length:var(--control-md)]';
