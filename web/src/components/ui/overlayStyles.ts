/**
 * The shared visual and stacking vocabulary for overlay surfaces (issue 3142).
 *
 * `Dialog` (Base UI) and `AlertDialog` (Radix) keep separate primitives because
 * their semantics differ — one hosts arbitrary content, the other must not be
 * dismissed by an outside click — but they are one visual family. The scrim,
 * surface treatment, title role and layer order live here so neither primitive
 * can drift into its own values.
 *
 * Layer order is deliberate and token-owned:
 * `tooltip (110) > anchored popup (100) > modal dialog/alert (50)`.
 * An anchored choice opened from a dialog must therefore paint above it; a
 * tooltip may paint above that choice.
 */
export const overlayScrimClass = 'fixed inset-0 bg-overlay-scrim';

export const overlayDialogZClass = 'z-[var(--nession-overlay-dialog-z)]';
export const overlayAnchoredZClass = 'isolate z-[var(--nession-overlay-anchored-z)]';
export const overlayTooltipZClass = 'isolate z-[var(--nession-overlay-tooltip-z)]';

export const overlaySurfaceClass =
  'rounded-xl bg-popover text-popover-foreground ring-1 ring-foreground/10 shadow-[var(--nession-elevation-floating)]';

export const overlayTitleClass = 'font-heading text-base leading-none font-medium';

export const overlayViewportWidthClass =
  'max-w-[length:var(--nession-overlay-viewport-max-width)]';
export const overlayViewportHeightClass =
  'max-h-[length:var(--nession-overlay-viewport-max-height)]';

const OVERLAY_SIZE_CLASS = {
  compact: 'sm:max-w-[length:var(--nession-overlay-compact-max-width)]',
  standard: 'sm:max-w-[length:var(--nession-overlay-standard-max-width)]',
  wide: 'sm:max-w-[length:var(--nession-overlay-wide-max-width)]',
} as const;

export type OverlaySize = keyof typeof OVERLAY_SIZE_CLASS;

/** The semantic width role of a centered overlay. */
export function overlaySizeClass(size: OverlaySize): string {
  return OVERLAY_SIZE_CLASS[size];
}

/**
 * A menu row's height is the experience's control band, resolved from the
 * popup's own container. This is the one owner for menu-like rows across
 * `DropdownMenu`, `Select` and `ContextMenu`; `PopupMenu` documents why Web
 * stays at `control.sm` (28px) while App's equals the 44px touch floor.
 */
export const popupMenuItemBandClass = 'min-h-[length:var(--nession-control-sm)]';
