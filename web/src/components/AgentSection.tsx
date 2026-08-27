import type { Agent } from '../types';
import { AgentCard } from './AgentCard';
import { Skeleton } from './ui/skeleton';

export function AgentSection({
  loadingAgents,
  agents,
  filteredAgents,
  isSearchActive,
  setSelectedAgent,
  onAgentRename,
  onAgentDelete,
}: {
  loadingAgents: boolean;
  agents: Agent[];
  filteredAgents: Agent[];
  isSearchActive: boolean;
  setSelectedAgent: (a: Agent | null) => void;
  onAgentRename?: (updated: Agent) => void;
  onAgentDelete?: (agent: Agent) => void;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Agents</h2>
      </div>
      {loadingAgents ? (
        <div className="flex md:grid gap-3 overflow-x-auto scrollbar-none md:overflow-visible md:grid-cols-3 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24 w-64 flex-shrink-0 md:w-auto rounded-xl" />
          ))}
        </div>
      ) : agents.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No agents connected</p>
      ) : filteredAgents.length === 0 && isSearchActive ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No agents match your search</p>
      ) : (
        <>
          {/* Mobile: always-visible horizontal strip — swipe through agents (issue #452).
              py-1 keeps the card ring (box-shadow) inside the overflow container. */}
          <div
            data-testid="agent-strip"
            className="flex gap-3 overflow-x-auto scrollbar-none -mx-3 px-3 py-1 md:hidden"
          >
            {filteredAgents.map((a) => (
              <div key={a.agent_id} className="w-72 flex-shrink-0">
                <AgentCard
                  agent={a}
                  onClick={() => setSelectedAgent(a)}
                  onRename={onAgentRename}
                  onDelete={onAgentDelete}
                />
              </div>
            ))}
          </div>
          {/* Desktop: responsive grid (md+), unchanged. */}
          <div data-testid="agent-grid" className="hidden md:grid gap-3 md:grid-cols-3 lg:grid-cols-4">
            {filteredAgents.map((a) => (
              <AgentCard
                key={a.agent_id}
                agent={a}
                onClick={() => setSelectedAgent(a)}
                onRename={onAgentRename}
                onDelete={onAgentDelete}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
