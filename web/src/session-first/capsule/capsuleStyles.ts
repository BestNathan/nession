/**
 * Capsule composer presentation classes — token vars only, no numeric Tailwind scale.
 */

/** Shared by textarea + ghost overlay so glyphs stay locked. */
export const capsuleFieldTypeClass =
  'font-sans text-[length:var(--composer-line-height)] leading-[length:var(--composer-line-height)] antialiased';

export const capsuleFieldPadClass =
  'px-3 py-[length:calc(var(--panel-padding)/2)]';

export const capsuleIconButtonClass =
  "h-[length:var(--control-md)] w-[length:var(--control-md)] shrink-0 [&_svg:not([class*='size-'])]:size-[length:var(--icon-md)]";

export const capsuleControlRowClass =
  'flex h-[length:var(--control-md)] shrink-0 items-center gap-1';

export const capsuleShellSurfaceClass =
  'border border-border bg-[color:var(--terminal-capsule-surface)] text-foreground shadow-lg backdrop-blur-sm';

export const capsuleShellInnerPadClass = 'px-3 py-2';

export const capsuleShellRadiusClass = 'rounded-[length:var(--radius-capsule)]';
