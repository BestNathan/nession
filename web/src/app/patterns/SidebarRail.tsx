import { PanelLeftOpen, Server, ListTree } from 'lucide-react';
import { cn } from '@/lib/utils';
import { shellIconButtonClass, shellMotionClass } from '@/app/shellStyles';
import type { ConnectionState } from '@/platform/socket';

export interface SidebarRailProps {
  /**
   * The client's own connection to the server — the one state that actually
   * threatens the current work.
   *
   * Not a per-node roll-up: `session-list.md` names "a list-level global health
   * indicator that collapses independent state dimensions" an anti-pattern, and
   * a dot that turns red because *some* node is offline does exactly that. An
   * idle node being down is not a reason to alarm the whole shell; the Agents
   * section says so on its own row.
   */
  connectionStatus: ConnectionState;
  onExpand: () => void;
}

/**
 * The sidebar collapsed to a rail.
 *
 * `session-list.md` allows "collapsible sidebar/rail" and warns that "a wide
 * screen does not automatically justify a permanently wider Session list", so
 * collapsing is a first-class state rather than a narrow-viewport fallback.
 *
 * The rail's job is to be a way back. Clicking anywhere on it — the expand
 * control or either section icon — restores the expanded sidebar, so the
 * collapsed state can never strand the user (`SC2`: "折叠态有回到侧栏的可见控制").
 *
 * Known gap, accepted knowingly by #748: while collapsed, nothing on screen
 * shows the active Session's name. That is the direct cost of the rail plus a
 * headerless shell; solving it would mean re-introducing header-like chrome.
 */
export function SidebarRail({ connectionStatus, onExpand }: SidebarRailProps) {
  const healthy = connectionStatus === 'connected';

  return (
    <nav
      data-testid="sidebar-rail"
      aria-label="Sidebar (collapsed)"
      className="flex w-[length:var(--shell-rail-width)] shrink-0 flex-col items-center gap-1 py-[var(--shell-space-2)]"
    >
      <button
        type="button"
        data-testid="sidebar-rail-expand"
        aria-label="Expand sidebar"
        title="Expand sidebar"
        onClick={() => onExpand()}
        className={cn(shellIconButtonClass, 'rounded-md hover:bg-accent hover:text-accent-foreground')}
      >
        <PanelLeftOpen className="size-[length:var(--icon-md)]" aria-hidden />
      </button>

      {/* Section entries. They are one control each rather than a labelled list,
          because at this width a label would not fit and the expanded sidebar is
          one click away. */}
      <button
        type="button"
        data-testid="sidebar-rail-agents"
        aria-label="Agents"
        title="Agents"
        onClick={() => onExpand()}
        className={cn(shellIconButtonClass, 'rounded-md hover:bg-accent hover:text-accent-foreground')}
      >
        <Server className="size-[length:var(--icon-md)]" aria-hidden />
      </button>
      <button
        type="button"
        data-testid="sidebar-rail-sessions"
        aria-label="Sessions"
        title="Sessions"
        onClick={() => onExpand()}
        className={cn(shellIconButtonClass, 'rounded-md hover:bg-accent hover:text-accent-foreground')}
      >
        <ListTree className="size-[length:var(--icon-md)]" aria-hidden />
      </button>

      <div className="flex-1" />

      {/* Service status, which the footer carries in full when expanded. */}
      <span
        data-testid="sidebar-rail-status"
        role="img"
        aria-label={`Server ${connectionStatus}`}
        className={cn(
          'size-[length:var(--shell-status-dot-size)] rounded-full',
          shellMotionClass,
          healthy ? 'bg-[var(--action)]' : 'bg-destructive',
        )}
      />
    </nav>
  );
}
