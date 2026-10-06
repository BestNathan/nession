import { cn } from '@/shared/lib/utils';
import type { CapsuleExperience } from '@/product/terminal/capsule/types';

/**
 * Workspace capability navigation visual grammar (#1451 / #1455).
 *
 * Workspace owns the navigation row and entry chrome; capabilities contribute
 * identity/state only. Geometry is intentionally relational with the resting
 * Conversation Capsule: one control.md band inside the same shell padding.
 */
export const workspaceCapabilityScrollClass =
  'flex min-w-0 items-center gap-[length:var(--nession-terminal-capsule-control-gap)] overflow-x-auto';

export const workspaceCapabilityEntryClass = [
  'relative flex h-[length:var(--nession-control-md)] w-[length:var(--nession-terminal-capsule-capability-slot-width)] shrink-0 items-center justify-center overflow-hidden',
  'gap-[length:var(--nession-terminal-capsule-control-gap)]',
  'rounded-[var(--nession-radius-control)] px-1',
  'transition-colors',
  'duration-[var(--nession-motion-shell-duration)]',
  'ease-[var(--nession-motion-shell-ease)]',
].join(' ');

/**
 * Intentional Experience variant inside one fixed outer band.
 *
 * Web has only 32px of control mass, so icon + label are horizontal. App has
 * the 44px touch band and can preserve the icon-over-label composition. Neither
 * variant may grow the entry or outer Capsule.
 */
export function workspaceCapabilityEntryLayoutClass(
  experience: CapsuleExperience,
): string {
  return experience === 'web' ? 'flex-row' : 'flex-col';
}

export function workspaceCapabilityStateClass({
  active,
}: {
  active: boolean;
}): string {
  return active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground';
}

export const workspaceCapabilityLabelBaseClass = cn(
  'min-w-0 max-w-full truncate whitespace-nowrap font-sans',
  'font-[number:var(--nession-typography-caption-weight)]',
  'leading-[var(--nession-typography-caption-line-height)]',
);

export const workspaceCapabilityLabelSizeClass =
  'text-[length:var(--nession-terminal-capsule-capability-label-font-size)]';

export function workspaceCapabilityLabelAlignmentClass(
  experience: CapsuleExperience,
): string {
  return experience === 'web' ? 'text-left' : 'text-center';
}

export const workspaceCapabilityIndicatorClass =
  'absolute bottom-0.5 size-1 rounded-full';

export function workspaceCapabilityIndicatorStateClass(active: boolean): string {
  return active ? 'bg-foreground' : 'bg-transparent';
}
