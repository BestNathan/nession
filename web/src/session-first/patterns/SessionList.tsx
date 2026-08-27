import { ScrollArea } from '@/components/ui/scroll-area';
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
  attachInFlightId: string | null;
  attachFailedId: string | null;
  onSelect: (session: Session) => void;
}

export function SessionList({
  sessions,
  agents,
  staleAgentIds,
  selectedId,
  clientSessionId,
  attachInFlightId,
  attachFailedId,
  onSelect,
}: SessionListProps) {
  if (sessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-muted-foreground text-sm">
        No sessions
      </div>
    );
  }

  const agentById = new Map(agents.map((agent) => [agent.agent_id, agent]));

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col">
        {sessions.map((session) => {
          const agent = agentById.get(session.agent_id);
          const domain = mapDomainState({
            session,
            agent,
            staleAgentIds,
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
            />
          );
        })}
      </div>
    </ScrollArea>
  );
}
