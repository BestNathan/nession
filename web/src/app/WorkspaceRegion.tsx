import { AppLayout } from '@/app/experiences/app/AppLayout';
import { useAppLayer } from '@/app/experiences/app/useAppLayer';
import { WebLayout, type MainProps } from '@/app/experiences/web/WebLayout';
import {
  resolveExperienceMode,
  type ExperienceMode,
} from '@/app/experienceMode';
import type { SortDirection, SortField, StatusFilter } from '@/app/useDashboard';
import type { DomainState } from '@/product/session/model/domainState';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { CapabilityId } from '@/product/capability';
import type { FileOps } from '@/capabilities/files';
import type { Agent, Session } from '@/types';
import type { ConnectionState } from '@/platform/socket';
import {
  emptyProjectShell,
  type ProjectShellProps,
  type SessionProjectContext,
} from '@/product/project/types';
import { ProjectDetail } from '@/product/project/components/ProjectDetail';
import { SessionProjectDialog } from '@/product/project/components/SessionProjectDialog';
import { resolveFocusedProject, relatedSessionsFor } from '@/product/project/model/focusedProject';
import { AppProjectDetail } from '@/app/patterns/AppProjectDetail';
import { useSessionProjectBinding } from '@/app/useSessionProjectBinding';

export interface WorkspaceRegionProps {
  connectionStatus: ConnectionState;
  agents: Agent[];
  filteredSessions: Session[];
  /** Every Session, for the focused Project's related-Session list. */
  sessions?: Session[];
  /**
   * Total Sessions before search/filter. The collapsed rail quotes this so a
   * hidden filter never redefines what the number means (#1196 §3).
   */
  totalSessionCount: number;
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
  onOpenWorktreeSession?: (worktree: import('@/capabilities/git/types').GitWorktree) => Promise<void>;
  onConfigure: (session: Session) => void;
  onKill: (session: Session) => void;
  onViewSessionDetails?: (session: Session) => void;
  onEditSessionDetails?: (session: Session) => void;
  onSurfaceChange: (surface: Surface) => void;
  onToolChange: (tool: CapabilityId) => void;
  isWide: boolean;
  /**
   * Explicit experience route (`?experience=web|app`). Absent keeps the
   * viewport default; a narrow viewport may explicitly keep the Web drawer.
   */
  experienceOverride?: ExperienceMode;
  showList: boolean;
  /** Mobile: leave the list overlay and return to the session detail. */
  onCloseDrawer: () => void;
  showDetail: boolean;
  onBackToSessions?: () => void;
  /** Project data and maintenance callbacks; a Project is independent of Session. */
  projectShell?: ProjectShellProps;
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
    connectionStatus, agents, filteredSessions, sessions = filteredSessions, totalSessionCount, staleAgents, selectedId, clientSessionId,
    loadingSessions, searchQuery, setSearchQuery, statusFilter, setStatusFilter,
    sortField, sortDirection, toggleSort, isSearchActive, selectedSession,
    selectedAgent, domain, surface, tool, fileOps, onCreate, onRefresh, onSelect,
    onConfigure, onKill, onViewSessionDetails, onEditSessionDetails,
    onSurfaceChange, onToolChange, onOpenWorktreeSession, isWide,
    experienceOverride, showList, onBackToSessions, onCloseDrawer, terminal,
    projectShell = emptyProjectShell(),
  } = props;

  // Which experience renders is a **viewport** fact by default (#1082), with
  // an explicit URL override for the one composition the viewport default
  // cannot reach: Web's narrow overlay drawer (#2851). The override selects
  // which composition renders; `isWide` still decides its geometry, so a
  // narrow Web remains a drawer rather than a squeezed column.
  const isApp = resolveExperienceMode(isWide, experienceOverride) === 'app';
  const projectBinding = useSessionProjectBinding();
  const focusedProject = resolveFocusedProject(
    selectedSession,
    projectShell.projects,
    projectShell.loading,
  );
  const sessionProject: SessionProjectContext | undefined = selectedSession
    ? {
        focusedProject,
        relatedSessions: relatedSessionsFor(selectedSession, sessions),
        onAssociate: () => projectBinding.open(selectedSession),
        onOpenSession: onSelect,
        onProjectSettings: projectShell.onSettings,
        onCreateProjectSession: projectShell.onCreateSession,
      }
    : undefined;
  const sessionProjectDialog = (
    <SessionProjectDialog
      session={projectBinding.target}
      projects={projectShell.projects}
      busy={projectBinding.busy}
      error={projectBinding.error}
      onSave={(projectId) => {
        void projectBinding.save(projectId);
      }}
      onClose={projectBinding.close}
    />
  );
  const { layer, onLayerChange, onLayerSelect, workspaceAvailable } = useAppLayer({
    selectedId,
    surface,
    active: isApp,
    onSurfaceChange,
    onSelect,
  });

  const sidebarProps = {
    agents, filteredSessions, totalSessionCount, staleAgents, selectedId, clientSessionId, connectionStatus, domain,
    loadingSessions, searchQuery, setSearchQuery, statusFilter, setStatusFilter,
    sortField, sortDirection, toggleSort, isSearchActive, onCreate, onRefresh,
    onConfigure, onKill, onViewDetails: onViewSessionDetails, onEditDetails: onEditSessionDetails,
    onAssociateProject: (session: Session) => projectBinding.open(session),
    projectShell,
  };

  // A Project's detail is a sibling destination, not a Session-scoped
  // Workspace view: both experiences render it without touching the current
  // Session selection, so the mounted Terminal survives the round trip.
  const selectedProject =
    projectShell.projects.find(
      (project) => project.project_id === projectShell.selectedProjectId,
    ) ?? null;
  const projectDetail = selectedProject ? (
    <ProjectDetail
      project={selectedProject}
      agents={agents}
      onCreateSession={projectShell.onCreateSession}
      onSettings={projectShell.onSettings}
    />
  ) : undefined;
  const appProjectDetail = selectedProject ? (
    <AppProjectDetail
      project={selectedProject}
      agents={agents}
      onCreateSession={projectShell.onCreateSession}
      onSettings={projectShell.onSettings}
      onBack={projectShell.onClose}
    />
  ) : null;

  const mainShared = {
    selectedSession, selectedAgent, agents, domain, tool, fileOps,
    onSurfaceChange, onToolChange,
    // The same handler the sidebar's New Session calls, so the App home's
    // primary action opens the one creation flow rather than a second one
    // (#1082). Web ignores it — its empty state is a caption beside a sidebar.
    onCreate,
    onOpenWorktreeSession,
    sessionProject,
  };

  // The two experiences, named. Which one renders is the whole of this
  // component's decision — everything above it is shared state, and everything
  // below it is a composition that lives in its own directory.
  if (isApp) {
    return (
      <>
        <AppLayout
          layer={layer}
          onLayerChange={onLayerChange}
          sidebarProps={sidebarProps}
          onLayerSelect={onLayerSelect}
          mainShared={mainShared}
          workspaceAvailable={workspaceAvailable}
          projectDetail={appProjectDetail}
          terminal={terminal}
        />
        {sessionProjectDialog}
      </>
    );
  }

  return (
    <>
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
        projectDetail={projectDetail}
      />
      {sessionProjectDialog}
    </>
  );
}
