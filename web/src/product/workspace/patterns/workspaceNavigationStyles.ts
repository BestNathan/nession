/**
 * Workspace capability navigation visual grammar (#1451).
 *
 * Workspace owns the navigation row and entry chrome; capabilities contribute
 * identity/state only. Keep material/geometry/typography decisions here so a
 * capability cannot restyle the global Workspace switcher from its feature
 * slice.
 */

export const workspaceCapabilityScrollClass =
  'flex items-center gap-[length:var(--nession-terminal-capsule-control-gap)] overflow-x-auto';

export const workspaceCapabilityEntryClass = [
  'relative flex shrink-0 flex-col items-center justify-center',
  'gap-[length:var(--nession-terminal-capsule-control-gap)]',
  'rounded-[var(--nession-radius-control)] px-1',
  'transition-colors',
  'duration-[var(--nession-motion-shell-duration)]',
  'ease-[var(--nession-motion-shell-ease)]',
].join(' ');

export function workspaceCapabilityStateClass({
  active,
  unavailable,
}: {
  active: boolean;
  unavailable: boolean;
}): string {
  if (unavailable) return 'cursor-default text-disabled-foreground';
  if (active) return 'text-foreground';
  return 'text-muted-foreground hover:text-foreground';
}

export const workspaceCapabilityLabelBaseClass = [
  'line-clamp-2 text-center font-sans',
  'font-[number:var(--nession-typography-caption-weight)]',
  'leading-[var(--nession-typography-caption-line-height)]',
].join(' ');

export function workspaceCapabilityLabelSizeClass(wrapped: boolean): string {
  return wrapped
    ? 'text-[length:var(--nession-terminal-capsule-capability-label-wrapped-font-size)]'
    : 'text-[length:var(--nession-terminal-capsule-capability-label-font-size)]';
}

export const workspaceCapabilityIndicatorClass =
  'absolute bottom-0.5 size-1 rounded-full';

export function workspaceCapabilityIndicatorStateClass(active: boolean): string {
  return active ? 'bg-foreground' : 'bg-transparent';
}
