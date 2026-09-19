import { SpatialLayout } from '@/app/experiences/app/SpatialLayout';
import { useAppSpatialIndex } from '@/app/experiences/app/useAppSpatialIndex';
import { WebLayout, type MainProps } from '@/app/experiences/web/WebLayout';
import type { SortDirection, SortField, StatusFilter } from '@/app/useDashboard';
import type { DomainState } from '@/product/session/model/domainState';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { CapabilityId } from '@/product/capability';
import type { FileOps } from '@/capabilities/files';
import type { Agent, Session } from '@/types';
import type { ConnectionState } from '@/platform/socket';

export interface WorkspaceRegionProps {
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
   * Fixture/testing override for the terminal. Defaults to the real attached
   * terminal. Applies only to the wide (non-spatial) render path; the spatial
   * layout always uses the real terminal. See `ShellMain.terminal` for the node
   * and function forms.
   */
  terminal?: MainProps['terminal'];
}

export function WorkspaceRegion(props: WorkspaceRegionProps) {
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

  // The two experiences, named. Which one renders is the whole of this
  // component's decision — everything above it is shared state, and everything
  // below it is a composition that lives in its own directory.
  if (useSpatial) {
    return (
      <SpatialLayout
        spatialIndex={spatialIndex}
        onIndexChange={onIndexChange}
        sidebarProps={sidebarProps}
        onSpatialSelect={onSpatialSelect}
        mainShared={mainShared}
      />
    );
  }

  return (
    <WebLayout
      isWide={isWide}
      showList={showList}
      onCloseDrawer={onCloseDrawer}
      onBackToSessions={onBackToSessions}
      sidebarProps={sidebarProps}
      onSelect={onSelect}
      onConfigure={onConfigure}
      mainShared={mainShared}
      surface={surface}
      terminal={terminal}
    />
  );
}
