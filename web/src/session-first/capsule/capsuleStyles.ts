/**
 * Capsule composer metrics — keep textarea, ghost overlay, and icon buttons
 * on the same vertical rhythm (`--control-md` / `--sf-capsule-line`).
 */
export const CAPSULE_LINE_PX = 20; // 1.25rem → --sf-capsule-line
export const CAPSULE_PAD_Y_PX = 12; // py-1.5 top+bottom
export const CAPSULE_SINGLE_HEIGHT_PX = 32; // --control-md
/** Subpixel / placeholder scrollHeight slack before counting a soft-wrap line. */
export const CAPSULE_SINGLE_HEIGHT_TOLERANCE_PX = 2;
export const CAPSULE_MAX_LINES = 5;
export const CAPSULE_MAX_HEIGHT_PX =
  CAPSULE_LINE_PX * CAPSULE_MAX_LINES + CAPSULE_PAD_Y_PX;

/**
 * Map textarea value + measured scrollHeight to composer line count.
 * Empty always stays 1 (flat), even when mobile browsers inflate scrollHeight.
 */
export function measureCapsuleLineCount(
  value: string,
  scrollHeight: number,
): number {
  if (value.length === 0) {
    return 1;
  }

  const fromBreaks = Math.max(1, value.split('\n').length);
  const hasHardBreak = value.includes('\n');
  if (
    !hasHardBreak &&
    scrollHeight <= CAPSULE_SINGLE_HEIGHT_PX + CAPSULE_SINGLE_HEIGHT_TOLERANCE_PX
  ) {
    return 1;
  }

  const fromHeight = Math.max(
    1,
    Math.ceil(Math.max(0, scrollHeight - CAPSULE_PAD_Y_PX) / CAPSULE_LINE_PX),
  );
  return Math.max(fromBreaks, fromHeight);
}

/** Shared by textarea + ghost overlay so glyphs stay locked. */
export const capsuleFieldTypeClass =
  'font-sans text-[length:var(--sf-text-body)] leading-[length:var(--sf-capsule-line)] antialiased';

export const capsuleFieldPadClass = 'px-3 py-1.5';

/** Desktop 32×32; mobile touch ≥44. */
export const capsuleIconButtonClass =
  "size-8 shrink-0 max-lg:size-11 [&_svg:not([class*='size-'])]:size-4";
