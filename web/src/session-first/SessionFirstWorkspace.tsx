import { SessionFirstMain } from '@/session-first/SessionFirstMain';
import { SessionFirstSidebar } from '@/session-first/SessionFirstSidebar';
import type { SortDirection, SortField, StatusFilter } from '@/hooks/useDashboard';
import type { DomainState } from '@/session-first/domainState';
import type { Surface } from '@/session-first/patterns/SessionHeader';
import type { WorkspaceToolId } from '@/session-first/patterns/WorkspaceNavigation';
import type { FileOps } from '@/services/fileOps';
import type { Agent, Session } from '@/types';

export interface SessionFirstWorkspaceProps {
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
  selectedSession: Session | null;
  selectedAgent: Agent | undefined;
  domain: DomainState | null;
  surface: Surface;
  tool: WorkspaceToolId;
  fileOps: FileOps | null;
  onCreate: () => void;
  onRefresh: () => void;
  onSelect: (session: Session) => void;
  onKill: (session: Session) => void;
  onSurfaceChange: (surface: Surface) => void;
  onToolChange: (tool: WorkspaceToolId) => void;
  onOpenAgent: () => void;
}

export function SessionFirstWorkspace(props: SessionFirstWorkspaceProps) {
  const {
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
    selectedSession,
    selectedAgent,
    domain,
    surface,
    tool,
    fileOps,
    onCreate,
    onRefresh,
    onSelect,
    onKill,
    onSurfaceChange,
    onToolChange,
    onOpenAgent,
  } = props;

  return (
    <div className="flex min-h-0 flex-1">
      <SessionFirstSidebar
        agents={agents}
        filteredSessions={filteredSessions}
        staleAgents={staleAgents}
        selectedId={selectedId}
        clientSessionId={clientSessionId}
        loadingSessions={loadingSessions}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        sortField={sortField}
        sortDirection={sortDirection}
        toggleSort={toggleSort}
        isSearchActive={isSearchActive}
        onCreate={onCreate}
        onRefresh={onRefresh}
        onSelect={onSelect}
        onKill={onKill}
      />
      <main className="flex min-h-0 flex-1 flex-col">
        <SessionFirstMain
          selectedSession={selectedSession}
          selectedAgent={selectedAgent}
          domain={domain}
          surface={surface}
          tool={tool}
          fileOps={fileOps}
          onSurfaceChange={onSurfaceChange}
          onToolChange={onToolChange}
          onOpenAgent={onOpenAgent}
        />
      </main>
    </div>
  );
}
