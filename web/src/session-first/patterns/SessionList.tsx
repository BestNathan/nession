import { SearchX } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { agentDisplayName } from '@/lib/format';
import { mapDomainState } from '@/session-first/domainState';
import { SessionItem } from '@/session-first/patterns/SessionItem';
import type { Agent, Session } from '@/types';

export interface SessionListProps {
  sessions: Session[];
  agents: Agent[];
  staleAgentIds: Iterable<string>;
  selectedId: string | null;
  clientSessionId: string;
  attachInFlightId?: string | null;
  attachFailedId?: string | null;
  loading?: boolean;
  isSearchActive?: boolean;
  onSelect: (session: Session) => void;
  onKill?: (session: Session) => void;
}

export function SessionList({
  sessions,
  agents,
  staleAgentIds,
  selectedId,
  clientSessionId,
  attachInFlightId = null,
  attachFailedId = null,
  loading = false,
  isSearchActive = false,
  onSelect,
  onKill,
}: SessionListProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-2">
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
      </div>
    );
  }

  if (sessions.length === 0) {
    if (isSearchActive) {
      return (
        <div className="flex flex-col items-center px-4 py-8 text-muted-foreground">
          <SearchX className="mb-2 size-8" />
          <p className="text-sm">No sessions match your search</p>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center p-4 text-muted-foreground text-sm">
        No sessions
      </div>
    );
  }

  const agentById = new Map(agents.map((agent) => [agent.agent_id, agent]));
  const staleSet = new Set(staleAgentIds);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col divide-y p-2">
        {sessions.map((session) => {
          const agent = agentById.get(session.agent_id);
          const domain = mapDomainState({
            session,
            agent,
            staleAgentIds: staleSet,
            clientSessionId,
            attachInFlightId,
            attachFailedId,
          });

          return (
            <SessionItem
              key={session.session_id}
              session={session}
              domain={domain}
              agentLabel={agent ? agentDisplayName(agent) : session.agent_id}
              selected={selectedId === session.session_id}
              onSelect={onSelect}
              onKill={onKill}
            />
          );
        })}
      </div>
    </ScrollArea>
  );
}
