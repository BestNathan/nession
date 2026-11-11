import * as React from 'react';

import { cn } from '@/shared/lib/utils';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';

/**
 * Shared Workspace layout recipes (#3194).
 *
 * These are deliberately *two* recipes, not a universal layout DSL. They own
 * the two repeated relationships that independent consumers were restating
 * with valid-but-drifting utility classes:
 *
 * - `WorkspaceMasterDetail` — a bounded Web master/detail surface: one host
 *   that clips, a fixed navigation column, and a fluid content panel. Files
 *   and Environment were the two copies; both now render through this owner.
 * - `WorkspaceScrollRegion` — the one scroll owner for an experience-composed
 *   Workspace view. It supplies the measured Capsule Zone clearance, so a view
 *   cannot own its own scroll ancestry and forget the dock.
 *
 * Local `flex` / `grid` / `min-w-0` / `min-h-0` / `flex-1` remain legal inside
 * capability content. What these recipes remove is the right to *restate* the
 * stable host geometry or to add a second page-level scroll owner. The runtime
 * marker (`data-workspace-layout`, `data-workspace-scroll-owner`) is what the
 * browser Case and the design Gate inspect; `design/scripts/layout-ownership.mjs`
 * rejects a consumer that copies either owner's stable class instead of using
 * the recipe.
 */

export interface WorkspaceScrollRegionProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

/** The runtime marker names the design Gate and browser Case assert. */
export const WORKSPACE_LAYOUT = Object.freeze({
  masterDetail: 'master-detail',
  scrollOwner: 'data-workspace-scroll-owner',
});

export function WorkspaceScrollRegion({ className, ...props }: WorkspaceScrollRegionProps) {
  return (
    <div
      data-workspace-scroll-owner="true"
      className={cn(
        'h-full min-h-0 overflow-y-auto pb-[env(safe-area-inset-bottom)]',
        workspaceScrollClearanceClass,
        className,
      )}
      {...props}
    />
  );
}

export interface WorkspaceMasterDetailProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The bounded navigation column (a tree/list). It owns its own local scroll. */
  navigation: React.ReactNode;
  children?: React.ReactNode;
}

export function WorkspaceMasterDetail({
  navigation,
  children,
  className,
  ...props
}: WorkspaceMasterDetailProps) {
  return (
    <div
      data-workspace-layout={WORKSPACE_LAYOUT.masterDetail}
      className={cn('h-full min-h-0 overflow-hidden', className)}
      {...props}
    >
      <div className="grid h-full min-h-0 grid-cols-[var(--nession-workspace-tree-width)_minmax(0,1fr)] overflow-hidden">
        <div
          data-workspace-layout-part="navigation"
          className="min-h-0 overflow-hidden bg-workspace-navigation"
        >
          {navigation}
        </div>
        <div data-workspace-layout-part="content" className="min-h-0 overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  );
}
