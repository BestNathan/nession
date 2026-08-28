import { ArrowDown, ArrowUp, SearchX } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { agentDisplayName } from '@/lib/format';
import type { SortDirection, SortField } from '@/hooks/useDashboard';
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
  loading?: boolean;
  isSearchActive?: boolean;
  sortField?: SortField;
  sortDirection?: SortDirection;
  toggleSort?: (field: SortField) => void;
  onSelect: (session: Session) => void;
  onKill?: (session: Session) => void;
}

function SortButton({
  label,
  field,
  activeField,
  direction,
  onToggle,
}: {
  label: string;
  field: SortField;
  activeField?: SortField;
  direction?: SortDirection;
  onToggle?: (field: SortField) => void;
}) {
  if (!onToggle) {
    return <span>{label}</span>;
  }
  return (
    <button
      type="button"
      className="flex items-center gap-1 hover:text-foreground"
      onClick={() => onToggle(field)}
    >
      {label}
      {activeField === field && (direction === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
    </button>
  );
}

export function SessionList({
  sessions,
  agents,
  staleAgentIds,
  selectedId,
  clientSessionId,
  attachInFlightId,
  attachFailedId,
  loading = false,
  isSearchActive = false,
  sortField,
  sortDirection,
  toggleSort,
  onSelect,
  onKill,
}: SessionListProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-2">
        <Skeleton className="h-12 w-full rounded-md" />
        <Skeleton className="h-12 w-full rounded-md" />
        <Skeleton className="h-12 w-full rounded-md" />
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
      {toggleSort ? (
        <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">
          <SortButton
            label="Name"
            field="name"
            activeField={sortField}
            direction={sortDirection}
            onToggle={toggleSort}
          />
          <SortButton
            label="Activity"
            field="activity"
            activeField={sortField}
            direction={sortDirection}
            onToggle={toggleSort}
          />
        </div>
      ) : null}
      <div className="flex flex-col divide-y">
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
