import { PanelLeftOpen, Server, ListTree } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
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
  /** Total registered Agents, online or not. */
  agentCount: number;
  onlineAgentCount: number;
  /**
   * Total Sessions, unfiltered. A collapsed rail quoting the filtered
   * population reads as "this is how much work exists" — a hidden filter must
   * not silently redefine that (#1196 §3).
   */
  sessionCount: number;
  /**
   * The currently shown (filtered) Session count, used only to make a narrow
   * result explicit ("2 shown · 8 total") rather than to replace the total.
   */
  shownSessionCount: number;
  onExpand: () => void;
}

/**
 * The sidebar collapsed to a rail (#1196).
 *
 * The rail has exactly **one** action — Expand. #748 gave it three (Expand,
 * Agents, Sessions) that all did the same thing; three controls with one
 * shared effect is a toolbar that lies about having semantics. What remains
 * beside Expand is *information*: how many Agents, how many Sessions, and
 * whether the server connection is healthy — the context that helps decide
 * whether expanding is worth it, and nothing else.
 *
 * The summaries are static on purpose: not buttons, not tab stops, no hover
 * affordance, and they never call `onExpand`. `session-list.md` allows the
 * rail itself but keeps navigation work-first — a rail that pretends to be
 * mini navigation is how the wide sidebar sneaks back in.
 *
 * Known gap, accepted knowingly by #748: while collapsed, nothing on screen
 * shows the active Session's name. That is the direct cost of the rail plus a
 * headerless shell; solving it would mean re-introducing header-like chrome.
 */
export function SidebarRail({
  connectionStatus,
  agentCount,
  onlineAgentCount,
  sessionCount,
  shownSessionCount,
  onExpand,
}: SidebarRailProps) {
  const healthy = connectionStatus === 'connected';
  const agentsLabel = `${agentCount} agents · ${onlineAgentCount} online`;
  const sessionsFiltered = shownSessionCount !== sessionCount;
  const sessionsLabel = sessionsFiltered
    ? `${shownSessionCount} shown of ${sessionCount} sessions`
    : `${sessionCount} sessions`;
  const sessionsTitle = sessionsFiltered
    ? `${shownSessionCount} shown · ${sessionCount} total`
    : sessionsLabel;

  return (
    <nav
      data-testid="sidebar-rail"
      aria-label="Sidebar (collapsed)"
      // h-full: the aside wrapper is a full-height flex column; without it the
      // nav shrink-wrapped its content, the flex-1 spacer collapsed to zero,
      // and the status dot sat directly under the summaries instead of pinned
      // to the bottom edge where the expanded footer carries it.
      className="flex h-full w-[length:var(--shell-rail-width)] shrink-0 flex-col items-center gap-1 py-[var(--shell-space-2)]"
    >
      <button
        type="button"
        data-testid="sidebar-rail-expand"
        aria-label="Expand sidebar"
        title="Expand sidebar"
        onClick={() => onExpand()}
        className={cn(shellIconButtonClass, 'rounded-[var(--radius-control)] hover:bg-accent hover:text-accent-foreground')}
      >
        <PanelLeftOpen className="size-[length:var(--icon-md)]" aria-hidden />
      </button>

      {/* Static summaries. `role="img"` + aria-label so the pair announces as
          one unit of information; the visible glyphs are presentational. No
          tabindex, no hover treatment, no click — these are not controls. */}
      <div
        data-testid="sidebar-rail-agents"
        role="img"
        aria-label={agentsLabel}
        title={agentsLabel}
        className="mt-[var(--shell-space-2)] flex flex-col items-center gap-[var(--shell-space-1)] py-[var(--shell-space-1)] text-muted-foreground"
      >
        <Server className="size-[length:var(--icon-md)]" aria-hidden />
        <span aria-hidden className="text-[length:var(--shell-section-head-font-size)] tabular-nums">
          {agentCount}
        </span>
      </div>
      <div
        data-testid="sidebar-rail-sessions"
        role="img"
        aria-label={sessionsLabel}
        title={sessionsTitle}
        className="flex flex-col items-center gap-[var(--shell-space-1)] py-[var(--shell-space-1)] text-muted-foreground"
      >
        <ListTree className="size-[length:var(--icon-md)]" aria-hidden />
        <span aria-hidden className="text-[length:var(--shell-section-head-font-size)] tabular-nums">
          {sessionCount}
        </span>
      </div>

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
