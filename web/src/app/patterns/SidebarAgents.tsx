import { cn } from '@/shared/lib/utils';
import { agentDisplayName } from '@/shared/lib/format';
import { SidebarSectionHead } from '@/app/patterns/SidebarSectionHead';
import type { Agent } from '@/types';

export interface SidebarAgentsProps {
  agents: Agent[];
  /** The agent the active Session runs on, if any. */
  activeAgentId: string | null;
  /**
   * Whether to draw the section's own "Agents" head.
   *
   * `false` for a caller that owns the head because it is also the section's
   * disclosure trigger — the App's Sessions surface (#1050). Drawing it in both
   * places would put two "Agents" labels in one disclosure. Defaults to `true`,
   * which is what the Web sidebar renders and has always rendered.
   */
  showSectionHead?: boolean;
}

/**
 * Infrastructure identity, at the top of the sidebar.
 *
 * This is where location context lives now that the Web shell has no header
 * (#748). It is deliberately *not* a navigation parent: Sessions stay flat and
 * never group under an Agent (`session-list.md`, anti-pattern 1). The list is
 * here so the user can see what the work is running on.
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
 */
export function SidebarAgents({
  agents,
  activeAgentId,
  showSectionHead = true,
}: SidebarAgentsProps) {
  if (agents.length === 0) {
    return null;
  }

  return (
    <section
      data-testid="sidebar-agents"
      aria-label="Agents"
      className="flex shrink-0 flex-col px-[var(--shell-space-2)]"
    >
      {showSectionHead ? <SidebarSectionHead label="Agents" /> : null}
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
                'flex w-full items-center gap-[var(--shell-space-2)] rounded-[var(--shell-session-row-radius)] px-[var(--shell-space-2)] py-[var(--shell-node-row-pad-y)] font-mono text-[length:var(--shell-node-font-size)]',
                active ? 'text-foreground' : 'text-[color:var(--text-secondary)]',
              )}
            >
                {/* The active-node marker. It is a *shape* today, not a colour:
                    nothing in the Web client knows whether a node is local or
                    remote (Agent carries no such field), and the Boundary axis
                    is only meaningful once that is known. See the PR note. */}
                <span
                  aria-hidden
                  className={cn(
                    'size-[length:var(--shell-status-dot-size)] shrink-0 rounded-full',
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
