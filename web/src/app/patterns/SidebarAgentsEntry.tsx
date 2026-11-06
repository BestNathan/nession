import { useState } from 'react';
import { ChevronDown, Server } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { SidebarAgents } from '@/app/patterns/SidebarAgents';
import { shellMotionClass } from '@/app/shellStyles';
import type { Agent } from '@/types';

/**
 * Infrastructure demoted to one disclosable entry below Session history.
 *
 * A roster at the top of the column made Agent the first thing a returning
 * user read; the Session list is the navigator. The rows themselves are still
 * `SidebarAgents` — inert, flat, and never a navigation parent — but they are
 * revealed only on request. The entry carries the fleet size, not a health
 * roll-up; the Server footer owns the connection mark.
 */
export function SidebarAgentsEntry({
  agents,
  activeAgentId,
  onlineCount,
}: {
  agents: Agent[];
  activeAgentId: string | null;
  onlineCount: number;
}) {
  const [open, setOpen] = useState(false);
  const countLabel = `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}, ${onlineCount} online`;

  return (
    <div data-testid="sidebar-agents-region" className="shrink-0 border-t">
      <button
        type="button"
        data-testid="sidebar-agents-entry"
        aria-expanded={open}
        aria-controls="sidebar-agents-panel"
        aria-label={`Agents and locations. ${countLabel}`}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex min-h-[length:var(--nession-control-lg)] w-full items-center gap-[var(--nession-shell-space-2)] rounded-[var(--nession-shell-session-row-radius)] px-[var(--nession-shell-space-2)] text-left text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          chromeSansRole('body'),
          shellMotionClass,
        )}
      >
        <Server className="size-[length:var(--nession-icon-md)] shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">Agents / locations</span>
        <span className={cn('shrink-0 tabular-nums text-muted-foreground', chromeSansRole('caption'))}>
          {agents.length}
        </span>
        <ChevronDown
          aria-hidden
          className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div
          id="sidebar-agents-panel"
          data-testid="sidebar-agents-panel"
          className="max-h-[min(40vh,20rem)] overflow-y-auto px-[var(--nession-shell-space-2)] pb-[var(--nession-shell-space-2)]"
        >
          <p className={cn('px-[var(--nession-shell-space-2)] pb-[var(--nession-shell-space-2)] text-muted-foreground', chromeSansRole('metadata'))}>
            Infrastructure context. Sessions stay reachable when their Agent is offline.
          </p>
          {agents.length > 0 ? (
            <SidebarAgents
              agents={agents}
              activeAgentId={activeAgentId}
              showSectionHead={false}
            />
          ) : (
            <p className={cn('px-[var(--nession-shell-space-2)] py-2 text-muted-foreground', chromeSansRole('metadata'))}>
              No Agents registered.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
