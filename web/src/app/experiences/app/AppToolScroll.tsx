import type { HTMLAttributes } from 'react';
import { cn } from '@/shared/lib/utils';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';

export type AppToolScrollProps = HTMLAttributes<HTMLDivElement>;

/**
 * App tool scroll container: full-height scroll area whose bottom padding
 * clears BOTH the home indicator and the floating tool bar.
 *
 * The toolbar's share used to be a constant — `var(--shell-space-3) + 2.75rem`,
 * the bar's offset plus a pill's height — which was an approximation of the
 * zone rather than a measurement of it (#1347 SC-12). It now spends
 * {@link workspaceScrollClearanceClass}, the same measured occlusion the Web
 * Scroll containers use, so a capsule that grows (a wider bar is the same
 * height, but an emptied one collapses to the surface action alone) moves the
 * clearance with it. The home indicator stays a constant: it is the OS's safe
 * area, not part of the Capsule Zone.
 */
export function AppToolScroll({ className, ...rest }: AppToolScrollProps) {
  return (
    <div
      className={cn(
        'h-full min-h-0 overflow-y-auto pb-[env(safe-area-inset-bottom)]',
        workspaceScrollClearanceClass,
        className,
      )}
      {...rest}
    />
  );
}
