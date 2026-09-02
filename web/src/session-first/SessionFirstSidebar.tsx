import { cn } from '@/lib/utils';
import { SessionList } from '@/session-first/patterns/SessionList';
import { SessionListHeader } from '@/session-first/patterns/SessionListHeader';
import { SessionFirstOverflowMenu } from '@/session-first/SessionFirstOverflowMenu';
import type { SortDirection, SortField, StatusFilter } from '@/hooks/useDashboard';
import type { Agent, Session } from '@/types';

export interface SessionFirstSidebarProps {
  className?: string;
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
  onOpenEnv: () => void;
  onLegacy: () => void;
}

export function SessionFirstSidebar({
  className,
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
  onOpenEnv,
  onLegacy,
}: SessionFirstSidebarProps) {
  const onlineCount = agents.filter((agent) => agent.status === 'online').length;
  const offlineCount = agents.filter((agent) => agent.status !== 'online').length;
  const createDisabled = agents.every((agent) => agent.status !== 'online');

  return (
    <aside
      data-testid="session-first-sidebar"
      className={cn(
        'flex h-full w-full shrink-0 flex-col',
        className,
      )}
    >
      <SessionListHeader
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        onlineCount={onlineCount}
        offlineCount={offlineCount}
        sortField={sortField}
        sortDirection={sortDirection}
        toggleSort={toggleSort}
        onCreate={onCreate}
        createDisabled={createDisabled}
        onRefresh={onRefresh}
        loadingSessions={loadingSessions}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <SessionList
          sessions={filteredSessions}
          agents={agents}
          staleAgentIds={staleAgents}
          selectedId={selectedId}
          clientSessionId={clientSessionId}
          loading={loadingSessions}
          isSearchActive={isSearchActive}
          onSelect={onSelect}
          onKill={onKill}
        />
      </div>
      <div
        data-testid="session-first-sidebar-footer"
        className="flex shrink-0 items-center justify-between gap-2 border-t px-[var(--sf-space-2)] py-[var(--sf-space-2)] pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        <SessionFirstOverflowMenu onOpenEnv={onOpenEnv} onLegacy={onLegacy} />
      </div>
    </aside>
  );
}
