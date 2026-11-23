import * as React from 'react';

import { cn } from '@/shared/lib/utils';
import { workspaceBoundedScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';

/**
 * The reusable bounded scrollport recipe (issue 4222, SC-01).
 *
 * A declared bounded Workspace surface owns an internal scroller. Before this
 * recipe, each capability built that scroller itself and appended
 * `workspaceBoundedScrollClearanceClass` to the same `className` it used for
 * content spacing. Tailwind class merging then let a caller's `p-2`, `pb-6` or
 * `py-3` override the host-measured bottom padding, so the last row ended
 * under the floating Capsule depending on which utility happened to be last.
 *
 * This recipe separates the two responsibilities into two elements:
 *
 * - the **viewport** carries the scroll role, the stable `min-h-0/flex-1/
 *   overflow` constraints and the measured trailing clearance. Caller
 *   `viewportClassName` is applied *before* the clearance class, so it can
 *   never win the merge;
 * - the **content** wrapper carries the caller's `className` — the spacing,
 *   flex/grid composition and typography of the rows inside. Padding here
 *   cannot touch the viewport's bottom inset. It is rendered only when there
 *   are content classes: a layout-sensitive reader (CodeMirror, a virtualized
 *   body) that passes none keeps its children directly in the viewport, so the
 *   recipe adds no sizing box that could move scroll ownership.
 *
 * The element publishes `data-workspace-scrollport="bounded"` and the
 * `nession-workspace-bounded-scroll` marker. `useWorkspaceCapsuleClearance`
 * measures every marked element individually against the live Capsule top, so
 * sibling scrollers at different bottom coordinates each receive their own
 * inset (issue 4222, SC-02). A capability never reads `visualViewport`, the Capsule
 * or a ResizeObserver of its own.
 *
 * Legitimate editor, virtualized-list and third-party readers (CodeMirror,
 * MessageScroller, TanStack Virtual) may keep their own viewport element, but
 * they implement this same observable contract: the bounded marker on the
 * element that really scrolls, and content padding outside the measured
 * trailing edge.
 */
export interface WorkspaceBoundedScrollportProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'className'> {
  /**
   * Content classes: spacing, layout and typography for what is inside the
   * scroll area. Applied to the inner wrapper, never to the scrolling
   * viewport, so a `p-*` here cannot override the measured bottom inset.
   */
  className?: string;
  /**
   * Structural classes for the scrolling viewport (for example `h-full`,
   * `shrink-0`, `overflow-auto` or a max-height). The measured clearance is
   * applied after these, so a bottom padding here is still overridden.
   */
  viewportClassName?: string;
  /** The scrolling viewport element (React 19 ref-as-prop). */
  ref?: React.Ref<HTMLDivElement>;
  children?: React.ReactNode;
}

export function WorkspaceBoundedScrollport({
  className,
  viewportClassName,
  children,
  ...props
}: WorkspaceBoundedScrollportProps) {
  return (
    <div
      {...props}
      data-workspace-scrollport="bounded"
      className={cn(
        'min-h-0 flex-1 overflow-y-auto overscroll-contain',
        viewportClassName,
        // Last on purpose: the measured host inset must win any merge against
        // caller padding (SC-01).
        workspaceBoundedScrollClearanceClass,
      )}
    >
      {className ? (
        <div data-workspace-scrollport-content="" className={cn('min-w-0', className)}>
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
