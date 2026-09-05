import { useState, type ReactNode } from 'react';
import { SessionFirstMain } from '@/session-first/SessionFirstMain';
import { SessionFirstSidebar } from '@/session-first/SessionFirstSidebar';
import { SessionDrawer } from '@/session-first/SessionDrawer';
import { SessionFirstSpatialLayout } from '@/session-first/SessionFirstSpatialLayout';
import { useAppSpatialIndex } from '@/session-first/app-spatial/useAppSpatialIndex';
import type { SortDirection, SortField, StatusFilter } from '@/hooks/useDashboard';
import type { DomainState } from '@/session-first/domainState';
import type { Surface } from '@/session-first/patterns/SessionHeader';
import type { WorkspaceToolId } from '@/session-first/workspace/toolTypes';
import type { FileOps } from '@/services/fileOps';
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
    onBackToSessions, onOpenEnv, onLegacy, terminal,
  } = props;

  const useSpatial = !isWide && selectedId !== null;
  const [showDrawer, setShowDrawer] = useState(false);
  const { spatialIndex, onIndexChange, onSpatialSelect } = useAppSpatialIndex({
    selectedId,
    surface,
    active: useSpatial,
    onSurfaceChange,
    onSelect,
  });

  const sidebarProps = {
    agents, filteredSessions, staleAgents, selectedId, clientSessionId,
    loadingSessions, searchQuery, setSearchQuery, statusFilter, setStatusFilter,
    sortField, sortDirection, toggleSort, isSearchActive, onCreate, onRefresh,
    onKill, onOpenEnv, onLegacy,
  };

  const mainShared = {
    selectedSession, selectedAgent, domain, tool, fileOps, connectionStatus,
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
    <div className="relative flex min-h-0 flex-1">
      <SessionDrawer
        open={!isWide ? showList : showDrawer}
        onClose={() => setShowDrawer(false)}
        sidebar={
          <SessionFirstSidebar
            {...sidebarProps}
            onSelect={(session) => {
              setShowDrawer(false);
              onSelect(session);
            }}
          />
        }
      />
      <main className="flex min-h-0 flex-1 flex-col">
        <SessionFirstMain
          {...mainShared}
          surface={surface}
          onBackToSessions={onBackToSessions}
          onOpenDrawer={() => setShowDrawer(true)}
          terminal={terminal}
        />
      </main>
    </div>
  );
}
