import { AppLayout } from '@/app/experiences/app/AppLayout';
import { useAppLayer } from '@/app/experiences/app/useAppLayer';
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

  // Which experience renders is a **viewport** fact, not a fact about the work
  // (#1082). It used to additionally require `selectedId !== null`, which meant
  // the App's composition — and everything that only exists inside it, the
  // Sessions layer and the top-level gesture included — was absent until work
  // already existed. Narrow viewports get the App experience; what the App
  // shows *inside* it is then a question about the Session, not about whether
  // the experience is on.
  const isApp = !isWide;
  const { layer, onLayerChange, onLayerSelect, workspaceAvailable } = useAppLayer({
    selectedId,
    surface,
    active: isApp,
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
    // The same handler the sidebar's New Session calls, so the App home's
    // primary action opens the one creation flow rather than a second one
    // (#1082). Web ignores it — its empty state is a caption beside a sidebar.
    onCreate,
  };

  // The two experiences, named. Which one renders is the whole of this
  // component's decision — everything above it is shared state, and everything
  // below it is a composition that lives in its own directory.
  if (isApp) {
    return (
      <AppLayout
        layer={layer}
        onLayerChange={onLayerChange}
        sidebarProps={sidebarProps}
        onLayerSelect={onLayerSelect}
        mainShared={mainShared}
        workspaceAvailable={workspaceAvailable}
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
