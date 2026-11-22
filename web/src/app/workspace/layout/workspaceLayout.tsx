import * as React from 'react';

import { cn } from '@/shared/lib/utils';
import { workspaceBoundedScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';

/**
 * Shared Workspace layout recipes (#3194, #4115).
 *
 * These are deliberately a small set of recipes, not a universal layout DSL.
 * They own the repeated relationships that independent consumers would
 * otherwise restate with valid-but-drifting utility classes:
 *
 * - `WorkspaceMasterDetail` — a bounded Web master/detail surface: one host
 *   that clips, a fixed navigation column, and a fluid content panel. Files
 *   and Environment were the two copies; both now render through this owner.
 * - `WorkspaceScrollRegion` — the one scroll owner for a Web-composed
 *   Workspace view. It supplies the measured Capsule Zone clearance, so a Web
 *   view cannot own its own scroll ancestry and forget the dock.
 * - `AppWorkspaceScrollRegion` — the **App host's default page scroll owner**
 *   (#4115). A capability that contributes ordinary block/section/row content
 *   is rendered inside it and gets correct end-of-scroll clearance without
 *   opting in to anything.
 * - `AppWorkspaceBoundedRegion` — the explicit host-managed fill adapter for a
 *   capability that genuinely owns an internal scroll surface (virtualized
 *   list, diff/transcript reader, editor). The capability spends
 *   `workspaceBoundedScrollClearanceClass` at that internal owner.
 *
 * Local `flex` / `grid` / `min-w-0` / `min-h-0` / `flex-1` remain legal inside
 * capability content. What these recipes remove is the right to *restate* the
 * stable host geometry or to add a second page-level scroll owner. The runtime
 * markers (`data-workspace-layout`, `data-workspace-scroll-owner`,
 * `data-workspace-app-surface`, `data-workspace-bounded-scroll`) are what the
 * browser Cases and the design Gate inspect; `design/scripts/layout-ownership.mjs`
 * rejects a consumer that copies an owner's stable class instead of using the
 * recipe.
 */

export interface WorkspaceScrollRegionProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

/** The runtime marker names the design Gate and browser Case assert. */
export const WORKSPACE_LAYOUT = Object.freeze({
  masterDetail: 'master-detail',
  scrollOwner: 'data-workspace-scroll-owner',
});

/**
 * Which kind of scroll surface the App host renders for a view (#4115).
 *
 * `document` is the default: the host wraps the capability's content in
 * `AppWorkspaceScrollRegion` and owns the page scroll. `bounded` is declared by
 * a capability whose view is itself a fill/internal-scroll surface; the host
 * gives it a full-height region and the capability's internal scroller spends
 * the host-published clearance.
 */
export type AppWorkspaceScrollMode = 'document' | 'bounded';

/** Marks the element the App host measured as the App Workspace surface. */
export const APP_WORKSPACE_SURFACE_ATTRIBUTE = 'data-workspace-app-surface';

export function WorkspaceScrollRegion({ className, ...props }: WorkspaceScrollRegionProps) {
  return (
    <div
      data-workspace-scroll-owner="true"
      className={cn(
        'h-full min-h-0 overflow-y-auto pb-[env(safe-area-inset-bottom)]',
        workspaceBoundedScrollClearanceClass,
        className,
      )}
      {...props}
    />
  );
}

/**
 * The App host's default page scroll owner (#4115).
 *
 * The scrollport is bounded by the shell's flex layout and is the one
 * vertical scroll ancestor for the depth. Its trailing padding is the host's
 * measured scroll inset — never a capability's number — and the inner wrapper
 * only guarantees that a short view still fills the viewport (`min-h-full`) so
 * a capability may keep using `flex-1` inside its own content without turning
 * that content into a second page scroll owner.
 */
export function AppWorkspaceScrollRegion({
  className,
  children,
  ...props
}: WorkspaceScrollRegionProps) {
  return (
    <div
      data-testid="app-workspace-scrollport"
      data-workspace-scroll-owner="true"
      {...{ [APP_WORKSPACE_SURFACE_ATTRIBUTE]: 'document' }}
      className={cn(
        'min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[var(--nession-local-workspace-scroll-bottom-inset,0px)]',
        className,
      )}
      {...props}
    >
      <div data-testid="app-workspace-scroll-content" className="flex min-h-full flex-col">
        {children}
      </div>
    </div>
  );
}

/**
 * The host-managed fill adapter for a declared bounded surface (#4115).
 *
 * The region fills the Workspace depth and clips; the capability's own
 * internal scroll owner remains the thing the finger/wheel reaches. It is not a
 * page scroll owner, and it deliberately carries no trailing padding: spending
 * the clearance inside the capability's scroller avoids reserving a permanently
 * shorter canvas around content that does not scroll.
 */
export function AppWorkspaceBoundedRegion({
  className,
  children,
  ...props
}: WorkspaceScrollRegionProps) {
  return (
    <div
      data-testid="app-workspace-bounded"
      data-workspace-app-bounded="true"
      {...{ [APP_WORKSPACE_SURFACE_ATTRIBUTE]: 'bounded' }}
      className={cn('relative flex min-h-0 flex-1 flex-col overflow-hidden', className)}
      {...props}
    >
      {children}
    </div>
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
