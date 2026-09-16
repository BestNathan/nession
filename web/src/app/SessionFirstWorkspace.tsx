import type { ReactNode } from 'react';
import { SessionFirstMain } from '@/app/SessionFirstMain';
import { SessionFirstSidebar } from '@/app/SessionFirstSidebar';
import { SessionDrawer } from '@/app/SessionDrawer';
import { SessionFirstSpatialLayout } from '@/app/SessionFirstSpatialLayout';
import { useAppSpatialIndex } from '@/app/app-spatial/useAppSpatialIndex';
import type { SortDirection, SortField, StatusFilter } from '@/app/useDashboard';
import type { DomainState } from '@/features/sessions/model/domainState';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { CapabilityId } from '@/features/capabilities';
import type { FileOps } from '@/features/files';
import type { Agent, Session } from '@/types';
import type { ConnectionState } from '@/services/socket';

export interface SessionFirstWorkspaceProps {
  connectionStatus: ConnectionState;
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
  tool: CapabilityId;
  fileOps: FileOps | null;
  onCreate: () => void;
  onRefresh: () => void;
  onSelect: (session: Session) => void;
  onConfigure: (session: Session) => void;
  onKill: (session: Session) => void;
  onSurfaceChange: (surface: Surface) => void;
  onToolChange: (tool: CapabilityId) => void;
  isWide: boolean;
  showList: boolean;
  /** Mobile: leave the list overlay and return to the session detail. */
  onCloseDrawer: () => void;
  showDetail: boolean;
  onBackToSessions?: () => void;
  /**
   * Fixture/testing override for the terminal surface. Defaults to the real
   * attached terminal. Applies only to the wide (non-spatial) render path;
   * the spatial layout always uses the real terminal.
   */
  terminal?: ReactNode;
}

export function SessionFirstWorkspace(props: SessionFirstWorkspaceProps) {
  const {
    connectionStatus, agents, filteredSessions, staleAgents, selectedId, clientSessionId,
    loadingSessions, searchQuery, setSearchQuery, statusFilter, setStatusFilter,
    sortField, sortDirection, toggleSort, isSearchActive, selectedSession,
    selectedAgent, domain, surface, tool, fileOps, onCreate, onRefresh, onSelect,
    onConfigure, onKill, onSurfaceChange, onToolChange, isWide,
    showList, onBackToSessions, onCloseDrawer, terminal,
  } = props;

  const useSpatial = !isWide && selectedId !== null;
  const { spatialIndex, onIndexChange, onSpatialSelect } = useAppSpatialIndex({
    selectedId,
    surface,
    active: useSpatial,
    onSurfaceChange,
    onSelect,
  });

  const sidebarProps = {
    agents, filteredSessions, staleAgents, selectedId, clientSessionId, connectionStatus, domain,
    loadingSessions, searchQuery, setSearchQuery, statusFilter, setStatusFilter,
    sortField, sortDirection, toggleSort, isSearchActive, onCreate, onRefresh,
    onConfigure, onKill,
  };

  const mainShared = {
    selectedSession, selectedAgent, agents, domain, tool, fileOps,
    onSurfaceChange, onToolChange,
  };

  if (useSpatial) {
    return (
      <SessionFirstSpatialLayout
        spatialIndex={spatialIndex}
        onIndexChange={onIndexChange}
        sidebarProps={sidebarProps}
        onSpatialSelect={onSpatialSelect}
        mainShared={mainShared}
      />
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      {isWide ? (
        /* Two columns above `lg` (the breakpoint the contract schema's enum
           permits and `useSessionFirstMobileNav` already uses). The sidebar is a
           real column here — it used to be an overlay drawer at every width,
           which meant the work surface never actually shared the frame. */
        <div
          data-testid="session-first-sidebar-column"
          className="flex min-h-0 w-[min(20rem,90vw)] shrink-0 border-r"
        >
          <SessionFirstSidebar {...sidebarProps} onSelect={onSelect} />
        </div>
      ) : (
        /* Below `lg` the sidebar is still an overlay: there is no room for a
           column that the work surface would have to share. */
        <SessionDrawer
          open={showList}
          onClose={() => onCloseDrawer()}
          sidebar={
            <SessionFirstSidebar
              {...sidebarProps}
              collapsible={false}
              onSelect={(session) => {
                onCloseDrawer();
                onSelect(session);
              }}
              onConfigure={(session) => {
                onCloseDrawer();
                onConfigure(session);
              }}
            />
          }
        />
      )}
      <main className="flex min-h-0 flex-1 flex-col">
        <SessionFirstMain
          {...mainShared}
          surface={surface}
          onOpenDrawer={() => onBackToSessions?.()}
          terminal={terminal}
        />
      </main>
    </div>
  );
}
