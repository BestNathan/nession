import { SessionList } from '@/session-first/patterns/SessionList';
import { SessionListHeader } from '@/session-first/patterns/SessionListHeader';
import type { SortDirection, SortField, StatusFilter } from '@/hooks/useDashboard';
import type { Agent, Session } from '@/types';

export interface SessionFirstSidebarProps {
  agents: Agent[];
  filteredSessions: Session[];
  staleAgents: string[];
  selectedId: string | null;
  clientSessionId: string;
  loadingSessions: boolean;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (f: StatusFilter) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  toggleSort: (field: SortField) => void;
  isSearchActive: boolean;
  onCreate: () => void;
  onRefresh: () => void;
  onSelect: (session: Session) => void;
  onKill: (session: Session) => void;
}

export function SessionFirstSidebar({
  agents,
  filteredSessions,
  staleAgents,
  selectedId,
  clientSessionId,
  loadingSessions,
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  sortField,
  sortDirection,
  toggleSort,
  isSearchActive,
  onCreate,
  onRefresh,
  onSelect,
  onKill,
}: SessionFirstSidebarProps) {
  const onlineCount = agents.filter((agent) => agent.status === 'online').length;
  const offlineCount = agents.filter((agent) => agent.status !== 'online').length;
  const createDisabled = agents.every((agent) => agent.status !== 'online');

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r">
      <SessionListHeader
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        onlineCount={onlineCount}
        offlineCount={offlineCount}
        onCreate={onCreate}
        createDisabled={createDisabled}
        onRefresh={onRefresh}
        loadingSessions={loadingSessions}
      />
      <SessionList
        sessions={filteredSessions}
        agents={agents}
        staleAgentIds={staleAgents}
        selectedId={selectedId}
        clientSessionId={clientSessionId}
        loading={loadingSessions}
        isSearchActive={isSearchActive}
        sortField={sortField}
        sortDirection={sortDirection}
        toggleSort={toggleSort}
        onSelect={onSelect}
        onKill={onKill}
      />
    </aside>
  );
}
