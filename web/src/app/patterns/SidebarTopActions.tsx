import { PanelLeftClose, Plus, X } from 'lucide-react';
import type { RefObject } from 'react';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { shellIconButtonClass, shellIconFocusClass, shellMotionClass } from '@/app/shellStyles';

export interface SidebarTopActionsProps {
  /** False in the narrow overlay, where there is no column to collapse. */
  collapsible: boolean;
  onCollapse?: () => void;
  /** Only used by the narrow overlay. */
  onCloseDrawer?: () => void;
  onCreate: () => void;
  createDisabled: boolean;
  /** The collapsed rail moves focus back here when the column expands. */
  collapseButtonRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * The Web sidebar's top navigation row (#2851).
 *
 * One shell toggle, one explicit New Session action, and (in the narrow
 * overlay) one Close action. The row is not a new product header: 52px is the
 * 36px shell control plus the two 8px insets, and it disappears with the
 * column when the sidebar is tucked away. Keeping creation here rather than in
 * the list chrome is what lets the Session list begin with Sessions instead of
 * a toolbar.
 */
export function SidebarTopActions({
  collapsible,
  onCollapse,
  onCloseDrawer,
  onCreate,
  createDisabled,
  collapseButtonRef,
}: SidebarTopActionsProps) {
  return (
    <div
      data-testid="sidebar-top-actions"
      className="flex min-h-[calc(var(--nession-shell-icon-button-size)+2*var(--nession-shell-space-2))] shrink-0 items-center gap-[var(--nession-shell-space-1)] px-[var(--nession-shell-space-2)] py-[var(--nession-shell-space-2)]"
    >
      {collapsible ? (
        <button
          type="button"
          ref={collapseButtonRef}
          data-testid="sidebar-collapse"
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          onClick={() => onCollapse?.()}
          className={cn(
            shellIconButtonClass,
            'rounded-[var(--nession-radius-control)] text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            shellIconFocusClass,
          )}
        >
          <PanelLeftClose className="size-[length:var(--nession-icon-md)]" aria-hidden />
        </button>
      ) : null}
      <Button
        type="button"
        size="lg"
        variant="outline"
        data-testid="create-session"
        aria-label="New Session"
        disabled={createDisabled}
        onClick={() => onCreate()}
        className={cn(
          'gap-[var(--nession-shell-space-2)] rounded-[var(--nession-radius-control)] border-border bg-background px-[var(--nession-shell-space-3)]',
          chromeSansRole('body'),
          shellMotionClass,
          collapsible ? 'ml-auto' : undefined,
        )}
      >
        <Plus className="size-[length:var(--nession-icon-md)]" aria-hidden />
        New Session
      </Button>
      {!collapsible && onCloseDrawer ? (
        <button
          type="button"
          data-testid="sidebar-drawer-close"
          aria-label="Close sessions"
          title="Close sessions"
          onClick={() => onCloseDrawer()}
          className={cn(
            'ml-auto',
            shellIconButtonClass,
            'rounded-[var(--nession-radius-control)] text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            shellIconFocusClass,
          )}
        >
          <X className="size-[length:var(--nession-icon-md)]" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
