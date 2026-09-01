/**
 * Capsule composer presentation classes — token vars only, no numeric Tailwind scale.
 */

/** Shared by textarea + ghost overlay so glyphs stay locked. */
export const capsuleFieldTypeClass =
  'font-sans text-[length:var(--composer-font-size)] leading-[length:var(--composer-text-line-height)] antialiased';

export const capsuleFieldPadClass =
  'px-[length:var(--composer-field-inset-x)] py-[length:var(--composer-field-inset-y)]';

/** Primary actions (Send) — full touch/control band. */
export const capsuleIconButtonClass =
  "h-[length:var(--control-md)] w-[length:var(--control-md)] shrink-0 [&_svg:not([class*='size-'])]:size-[length:var(--icon-md)]";

/** Secondary toolbar icons — smaller band so the field keeps width. */
export const capsuleSecondaryIconButtonClass =
  "h-[length:var(--control-sm)] w-[length:var(--control-sm)] shrink-0 [&_svg:not([class*='size-'])]:size-[length:var(--icon-sm)]";

export const capsuleControlRowClass =
  'flex h-[length:var(--control-md)] shrink-0 items-center gap-[length:var(--composer-control-gap)]';

export const capsuleShellSurfaceClass =
  'border border-border bg-[color:var(--terminal-capsule-surface)] text-foreground shadow-lg backdrop-blur-sm';

export const capsuleShellInnerPadClass =
  'px-[length:var(--composer-shell-pad-x)] py-[length:var(--composer-shell-pad-y)]';

export const capsuleShellRadiusClass = 'rounded-[length:var(--radius-capsule)]';

export const capsuleComposerGridGapClass = 'gap-[length:var(--composer-row-gap)]';

export const capsuleComposerRowGapYClass = 'gap-y-[length:var(--composer-toolbar-row-gap)]';
