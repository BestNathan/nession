import { cn } from '@/shared/lib/utils';
import { capsuleFloatingMaterialClass } from '@/product/terminal/capsule/capsuleStyles';

/**
 * Surface destination action visual grammar (#1204 / #1455).
 *
 * The destination is intentionally a circle, but its floating material belongs
 * to the same Capsule family as the long control beside it.
 */
export const surfaceDestinationActionClass = cn(
  capsuleFloatingMaterialClass,
  'pointer-events-auto relative flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-[var(--nession-motion-shell-duration)] ease-[var(--nession-motion-shell-ease)] hover:text-foreground focus-visible:text-foreground motion-reduce:transition-none',
);

export const surfaceDestinationActionBandClass =
  'size-[length:calc(var(--nession-control-md)+2*var(--nession-terminal-capsule-shell-pad-y))]';
