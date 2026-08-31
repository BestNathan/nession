/**
 * Capsule composer metrics — keep textarea, ghost overlay, and icon buttons
 * on the same vertical rhythm (`--control-md` / `--sf-capsule-line`).
 */
export const CAPSULE_LINE_PX = 20; // 1.25rem → --sf-capsule-line
export const CAPSULE_PAD_Y_PX = 12; // py-1.5 top+bottom
export const CAPSULE_SINGLE_HEIGHT_PX = 32; // --control-md
export const CAPSULE_MAX_LINES = 5;
export const CAPSULE_MAX_HEIGHT_PX =
  CAPSULE_LINE_PX * CAPSULE_MAX_LINES + CAPSULE_PAD_Y_PX;

/** Shared by textarea + ghost overlay so glyphs stay locked. */
export const capsuleFieldTypeClass =
  'font-sans text-[length:var(--sf-text-body)] leading-[length:var(--sf-capsule-line)] antialiased';

export const capsuleFieldPadClass = 'px-3 py-1.5';

/** Desktop 32×32; mobile touch ≥44. */
export const capsuleIconButtonClass =
  "size-8 shrink-0 max-lg:size-11 [&_svg:not([class*='size-'])]:size-4";
