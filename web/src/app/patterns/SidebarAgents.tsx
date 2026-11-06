import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { agentDisplayName } from '@/shared/lib/format';
import { SidebarSectionHead } from '@/app/patterns/SidebarSectionHead';
import type { Agent } from '@/types';

export interface SidebarAgentsProps {
  agents: Agent[];
  /** The agent the active Session runs on, if any. */
  activeAgentId: string | null;
  /**
   * Optional trailing control in the section head (`SidebarSectionHead`'s
   * `action` slot). A caller that owns a disclosure head may use it for that
   * disclosure's control.
   */
  action?: ReactNode;
  /**
   * Whether to draw the section's own "Agents" head.
   *
   * `false` for a caller that owns the head because it is also the section's
   * disclosure trigger — both current callers pass it: the Web entry (#2851)
   * and the App's Sessions surface (#1050). Drawing it in both places would put
   * two "Agents" labels in one disclosure. Defaults to `true` for a standalone
   * caller that has not supplied its own head.
   */
  showSectionHead?: boolean;
}

/**
 * Infrastructure identity, revealed on demand.
 *
 * This is where location context lives now that the Web shell has no header
 * (#748). Web reveals it from the lower Agents / locations entry (#2851); the App
 * uses it inside its own Sessions disclosure. It is deliberately *not* a
 * navigation parent: Sessions stay flat and never group under an Agent
 * (`session-list.md`, anti-pattern 1).
 *
 * **Rows are not controls.** #748 settles that this section exists and carries
 * the active-node marker, but leaves its actions undecided (its Open Question 3
 * asks exactly that, with the `+`'s semantics unnamed). Rendering an inert row
 * is honest; inventing a navigation semantic the design has not chosen would not
 * be. "Infrastructure identity" is what this section is for today.
 *
 * Rows are neutral. `session-list.md` forbids "decorative per-Agent coloring",
 * and the Boundary axis colours a node only when the boundary has been crossed —
 * see the note on the active marker below.
 *
 * **Rows are set in the product face, not monospace** (#1050 stage 4). This row
 * is infrastructure *context* — a node's name and how much work sits on it — and
 * the typography rule reserves monospace for technical workload identity
 * ("foreground command; technical ID; path/location where appropriate"), adding
 * explicitly that infrastructure/navigation chrome is not rendered in mono by
 * default. The token description that used to argue the opposite ("a node name
 * is infrastructure identity" → monospace) cited `visual-language.md` for a
 * licence the document does not give: its mono role is "terminal text, paths,
 * commands, code". Both experiences render this section, so the fix is shared
 * rather than App-only.
 *
 * The count keeps `tabular-nums`. That is the property monospace was actually
 * contributing here — digits that do not jitter as a heartbeat changes them —
 * and it is a font feature, so the product face provides it. It is also what the
 * sibling Agents count in the App's disclosure trigger already uses
 * (`AppSessionsSurface`), which would otherwise be the same quantity set two
 * ways in one surface.
 */
export function SidebarAgents({
  agents,
  activeAgentId,
  action,
  showSectionHead = true,
}: SidebarAgentsProps) {
  // With no head and no rows there is nothing to show; but when a head (or a
  // caller-supplied head action) is present it must not vanish with the Agent
  // count — a shell control that disappears based on data is exactly the
  // "jumping control" #1196 removes.
  if (agents.length === 0 && (!showSectionHead || action === undefined)) {
    return null;
  }

  return (
    <section
      data-testid="sidebar-agents"
      aria-label="Agents"
      className="flex shrink-0 flex-col px-[var(--nession-shell-space-2)]"
    >
      {showSectionHead ? <SidebarSectionHead label="Agents" action={action} /> : null}
      <ul className="flex flex-col">
        {agents.map((agent) => {
          const active = agent.agent_id === activeAgentId;
          const online = agent.status === 'online';
          return (
            <li
              key={agent.agent_id}
              data-testid={`sidebar-agent-${agent.agent_id}`}
              data-agent-active={active ? 'true' : undefined}
              title={`${agentDisplayName(agent)} — ${online ? 'online' : agent.status}`}
              className={cn(
                'flex w-full items-center gap-[var(--nession-shell-space-2)] rounded-[var(--nession-shell-session-row-radius)] px-[var(--nession-shell-space-2)] py-[var(--nession-shell-node-row-pad-y)]',
                chromeSansRole('secondary'),
                active ? 'text-foreground' : 'text-[color:var(--nession-text-secondary)]',
              )}
            >
                {/* The active-node marker. It is a *shape* today, not a colour:
                    nothing in the Web client knows whether a node is local or
                    remote (Agent carries no such field), and the Boundary axis
                    is only meaningful once that is known. See the PR note. */}
                <span
                  aria-hidden
                  className={cn(
                    'size-[length:var(--nession-shell-status-dot-size)] shrink-0 rounded-full',
                    active ? 'bg-foreground' : 'bg-border',
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{agentDisplayName(agent)}</span>
                <span className="shrink-0 tabular-nums">{agent.session_count}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
