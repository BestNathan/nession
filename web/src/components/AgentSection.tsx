import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { Agent } from '../types';
import { AgentCard } from './AgentCard';
import { Skeleton } from './ui/skeleton';
import { cn } from '@/lib/utils';

export function AgentSection({
  loadingAgents,
  agents,
  filteredAgents,
  isSearchActive,
  setSelectedAgent,
  onlineCount,
  offlineCount,
  onAgentRename,
  onAgentDelete,
}: {
  loadingAgents: boolean;
  agents: Agent[];
  filteredAgents: Agent[];
  isSearchActive: boolean;
  setSelectedAgent: (a: Agent | null) => void;
  onlineCount: number;
  offlineCount: number;
  onAgentRename?: (updated: Agent) => void;
  onAgentDelete?: (agent: Agent) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const gridClass = 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4';
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Agents</h2>
      </div>
      <button
        type="button"
        data-testid="agent-summary-bar"
        onClick={() => setExpanded((v) => !v)}
        className="md:hidden w-full flex items-center justify-between rounded-lg border px-3 min-h-11 mb-2 text-sm"
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-500" /> {onlineCount} online
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="w-2 h-2 rounded-full bg-gray-400" /> {offlineCount} offline
          </span>
        </span>
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      {loadingAgents ? (
        <div className={cn(expanded ? 'grid' : 'hidden', 'md:grid gap-3', gridClass)}>
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
        </div>
      ) : agents.length === 0 ? (
        <p className={cn(expanded ? 'block' : 'hidden', 'md:block text-sm text-muted-foreground py-8 text-center')}>No agents connected</p>
      ) : filteredAgents.length === 0 && isSearchActive ? (
        <p className={cn(expanded ? 'block' : 'hidden', 'md:block text-sm text-muted-foreground py-8 text-center')}>No agents match your search</p>
      ) : (
        <div className={cn(expanded ? 'grid' : 'hidden', 'md:grid gap-3', gridClass)}>
          {filteredAgents.map((a) => (
            <AgentCard key={a.agent_id} agent={a} onClick={() => setSelectedAgent(a)} onRename={onAgentRename} onDelete={onAgentDelete} />
          ))}
        </div>
      )}
    </section>
  );
}
