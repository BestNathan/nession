import { PanelLeftClose, Plus, X } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { shellIconButtonClass, shellMotionClass } from '@/app/shellStyles';

const controlFocus =
  'focus-visible:outline-solid focus-visible:outline-[length:var(--nession-focus-ring-width)] focus-visible:outline-ring focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))]';

export interface SidebarTopActionsProps {
  /** False in the narrow overlay, where there is no column to collapse. */
  collapsible: boolean;
  onCollapse?: () => void;
  /** Only used by the narrow overlay. */
  onCloseDrawer?: () => void;
  onCreate: () => void;
  createDisabled: boolean;
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
}: SidebarTopActionsProps) {
  return (
    <div
      data-testid="sidebar-top-actions"
      className="flex min-h-[calc(var(--nession-shell-icon-button-size)+2*var(--nession-shell-space-2))] shrink-0 items-center gap-[var(--nession-shell-space-1)] px-[var(--nession-shell-space-2)] py-[var(--nession-shell-space-2)]"
    >
      {collapsible ? (
        <button
          type="button"
          data-testid="sidebar-collapse"
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          onClick={() => onCollapse?.()}
          className={cn(
            shellIconButtonClass,
            'rounded-[var(--nession-radius-control)] text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            controlFocus,
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
            controlFocus,
          )}
        >
          <X className="size-[length:var(--nession-icon-md)]" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
