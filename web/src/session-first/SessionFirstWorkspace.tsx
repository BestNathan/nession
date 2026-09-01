import type { ReactNode } from 'react';
import { SessionFirstMain } from '@/session-first/SessionFirstMain';
import { SessionFirstSidebar } from '@/session-first/SessionFirstSidebar';
import { SessionFirstSpatialLayout } from '@/session-first/SessionFirstSpatialLayout';
import { useAppSpatialIndex } from '@/session-first/app-spatial/useAppSpatialIndex';
import { cn } from '@/lib/utils';
import type { SortDirection, SortField, StatusFilter } from '@/hooks/useDashboard';
import type { DomainState } from '@/session-first/domainState';
import type { Surface } from '@/session-first/patterns/SessionHeader';
import type { WorkspaceToolId } from '@/session-first/patterns/WorkspaceNavigation';
import type { FileOps } from '@/services/fileOps';
import type { Agent, ConnectionStatus, Session } from '@/types';

export interface SessionFirstWorkspaceProps {
  connectionStatus: ConnectionStatus;
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
  isWide: boolean;
  showList: boolean;
  showDetail: boolean;
  onBackToSessions?: () => void;
  onOpenEnv: () => void;
  onLegacy: () => void;
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
    onKill, onSurfaceChange, onToolChange, onOpenAgent, isWide, showList,
    showDetail, onBackToSessions, onOpenEnv, onLegacy, terminal,
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
    connectionStatus, agents, filteredSessions, staleAgents, selectedId, clientSessionId,
    loadingSessions, searchQuery, setSearchQuery, statusFilter, setStatusFilter,
    sortField, sortDirection, toggleSort, isSearchActive, onCreate, onRefresh,
    onKill, onOpenEnv, onLegacy,
  };

  const mainShared = {
    selectedSession, selectedAgent, domain, tool, fileOps,
    onSurfaceChange, onToolChange, onOpenAgent,
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
    <div className="flex min-h-0 flex-1">
      <SessionFirstSidebar
        className={cn(!showList && 'hidden lg:flex')}
        {...sidebarProps}
        onSelect={onSelect}
      />
      <main className={cn('flex min-h-0 flex-1 flex-col', !showDetail && 'hidden lg:flex')}>
        <SessionFirstMain
          {...mainShared}
          surface={surface}
          onBackToSessions={onBackToSessions}
          terminal={terminal}
        />
      </main>
    </div>
  );
}
