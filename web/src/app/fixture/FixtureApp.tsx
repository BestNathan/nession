import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AppLayout } from '@/app/experiences/app/AppLayout';
import { useAppLayer } from '@/app/experiences/app/useAppLayer';
import { useSessionDetails } from '@/app/useSessionDetails';
import { SessionDetailsDialog } from '@/app/patterns/SessionDetailsDialog';
import { filterSessions, type SortDirection, type SortField, type StatusFilter } from '@/app/useDashboard';
import { useDashboardFilter } from '@/app/useDashboardFilter';
import { mapDomainState, type DomainState } from '@/product/session/model/domainState';
import { FixtureTerminal } from '@/app/fixture/FixtureTerminal';
import { useFixtureProjectShell } from './fixtureProjects';
import { FixtureProjectDialogs } from './FixtureProjectDialogs';
import { FixtureAppProjectDetail } from './FixtureAppProjectDetail';
import type { ProjectShellProps, SessionProjectContext } from '@/product/project/types';
import { SessionProjectDialog } from '@/product/project/components/SessionProjectDialog';
import { useSessionProjectBinding } from '@/app/useSessionProjectBinding';
import type { TerminalChrome } from '@/app/ShellMain';
import type { Agent, Session } from '@/types';
import type { SidebarProps } from '@/app/Sidebar';
import { FIXTURE_CLIENT_SESSION_ID } from '@/app/fixture/fixtureData';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { CapabilityId } from '@/product/capability';
import { claudeCodeApi } from '@/capabilities/claude-code';
import { commandsApi } from '@/capabilities/commands';
import { envApi } from '@/capabilities/env';
import { gitApi } from '@/capabilities/git';
import { fixtureAgents } from './fixtureAgents';
import { fixtureCommandsSurface } from './fixtureCommands';
import { fixtureConnection } from './fixtureConnection';
import { fixtureTranscriptsSurface } from './fixtureTranscripts';
import { fixtureEnvSurface } from './fixtureEnv';
import { fixtureFileOps } from './fixtureFileOps';
import { fixtureGitSurface } from './fixtureGit';
import { fixtureInputDrop } from './fixtureInputDrop';
import { fixtureStatusInputs } from './fixtureStatusNotices';
import { fixturePaneCommand } from './fixturePaneCommand';
import { fixtureSelectedId } from './fixtureSelection';
import { useFixtureSessions } from './useFixtureSessions';
import {
  resolveFocusedProject,
  relatedSessionsFor,
} from '@/product/project/model/focusedProject';
import { fixtureStaleAgents } from './fixtureStaleAgents';
import { fixtureOperation } from './fixtureOperations';
import { fixtureSelectedSession } from './fixtureSelectedSession';
import { AppAttachSurface } from '@/app/experiences/app/AppAttachSurface';
import { AppCreateSessionSurface } from '@/app/experiences/app/AppCreateSessionSurface';

// Module-stable — the stub is immutable and stateless (same pattern as
// FixtureWorkspace's fixtureOps).
const fixtureOps = fixtureFileOps();

/**
 * Canonical App Active Terminal screen (#561 Phase 2C): the Terminal-root
 * layer composition at 390×844 (#1049) — single-row App header, static
 * terminal with the app scroll overlay, files plugin app layout,
 * deterministic data. No network. Also the Phase 6 baseline source.
 *
 * The fixture renders `AppLayout` directly rather than reimplementing the
 * composition, so the canonical baseline reflects shipped geometry. It used to
 * build its own `AppSpatialShell` with a reversed surface/index derivation,
 * which meant the fixture and the product could disagree about the shell
 * without any test noticing.
 *
 * The Session list is the product's, not a snapshot of one (#1050 stage 5):
 * the filter/sort state is `useDashboardFilter` and the list is
 * `filterSessions`, which is exactly the pair `useDashboard` composes with its
 * transport. So the search field filters, the Filters disclosure sorts, and the
 * route renders an order the app can reach — the three props that used to be
 * static (`searchQuery: ''`, `setSearchQuery: () => {}` and the unfiltered
 * list) made the field inert and left the canonical screen showing a Session
 * order no sort in the product produces.
 */
/**
 * The App fixture's details/edit owner (#2875). Extracted so the canonical
 * fixture component stays within the one-screen size budget while composing
 * the same `useSessionDetails` + `SessionDetailsDialog` pair as the shipped
 * App; the row menu's first two actions become reachable here.
 */
function useFixtureSessionDetails(
  agents: Agent[],
  staleAgents: string[],
) {
  const details = useSessionDetails({
    agents,
    staleAgentIds: staleAgents,
    clientSessionId: FIXTURE_CLIENT_SESSION_ID,
  });
  return {
    onViewDetails: (session: Session) => details.show(session, false),
    onEditDetails: (session: Session) => details.show(session, true),
    dialog: (
      <SessionDetailsDialog
        session={details.target?.session ?? null}
        state={details.domain}
        editing={details.target?.editing ?? false}
        onClose={details.close}
      />
    ),
  };
}


/**
 * The App fixture's `SidebarProps`, split out so the canonical fixture
 * component stays within the one-screen code budget. The row actions forward
 * the shipped details/edit owner (#2875); the remaining handlers stay inert.
 */
function fixtureSidebarProps({
  agents,
  filteredSessions,
  sessions,
  staleAgents,
  selectedId,
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  sortField,
  sortDirection,
  toggleSort,
  isSearchActive,
  connectionStatus,
  domain,
  sessionDetails,
  projectShell,
  onAssociateProject,
  onCreate,
  onConfigure,
}: {
  agents: Agent[];
  filteredSessions: Session[];
  sessions: Session[];
  staleAgents: string[];
  selectedId: SidebarProps['selectedId'];
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (value: StatusFilter) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  toggleSort: (field: SortField) => void;
  isSearchActive: boolean;
  connectionStatus: SidebarProps['connectionStatus'];
  domain: DomainState | null;
  sessionDetails: ReturnType<typeof useFixtureSessionDetails>;
  projectShell: ProjectShellProps;
  onAssociateProject: (session: Session) => void;
  onCreate: () => void;
  onConfigure: (session: Session) => void;
}) {
  return {
    onAssociateProject,
    agents,
    filteredSessions,
    // The unfiltered population: this fixture exercises real filters.
    totalSessionCount: sessions.length,
    staleAgents,
    selectedId,
    clientSessionId: FIXTURE_CLIENT_SESSION_ID,
    loadingSessions: false,
    searchQuery,
    setSearchQuery,
    statusFilter,
    setStatusFilter,
    sortField,
    sortDirection,
    toggleSort,
    isSearchActive,
    connectionStatus,
    domain,
    onCreate,
    onRefresh: () => {},
    onConfigure,
    onKill: () => {},
    onViewDetails: sessionDetails.onViewDetails,
    onEditDetails: sessionDetails.onEditDetails,
    projectShell,
  };
}

function fixtureAppMainShared({
  selectedSession,
  selectedAgent,
  agents,
  domain,
  tool,
  setSurface,
  setTool,
  sessionProject,
  onCreate,
}: {
  selectedSession: Session | null;
  selectedAgent: Agent | undefined;
  agents: Agent[];
  domain: DomainState | null;
  tool: CapabilityId;
  setSurface: (surface: Surface) => void;
  setTool: (tool: CapabilityId) => void;
  sessionProject?: SessionProjectContext;
  onCreate: () => void;
}) {
  return {
    selectedSession,
    sessionProject,
    selectedAgent,
    agents,
    domain,
    tool,
    fileOps: fixtureOps,
    connectionStatus: 'connected' as const,
    onSurfaceChange: setSurface,
    onToolChange: setTool,
    onOpenAgent: () => {},
    // Inert, like every other handler here: the home's "New Session" opens the
    // product's dialog, and a fixture that opened one would be asserting on a
    // flow it does not own (#1082).
    onCreate,
  };
}

function fixtureSessionProject(
  selectedSession: Session | null,
  sessions: Session[],
  projectShell: ProjectShellProps,
): SessionProjectContext | undefined {
  if (!selectedSession) {
    return undefined;
  }
  return {
    focusedProject: resolveFocusedProject(
      selectedSession,
      projectShell.projects,
      projectShell.loading,
    ),
    relatedSessions: relatedSessionsFor(selectedSession, sessions),
    onAssociate: () => {},
    onOpenSession: () => {},
    onProjectSettings: projectShell.onSettings,
    onCreateProjectSession: projectShell.onCreateSession,
  };
}

function FixtureAppDialogs({
  sessionDetails,
  projectBinding,
  projectLayer,
  agents,
  selectedSession,
  attachIntent,
  onAttachClose,
  createOpen,
  onCreateClose,
}: {
  sessionDetails: ReturnType<typeof useFixtureSessionDetails>;
  projectBinding: ReturnType<typeof useSessionProjectBinding>;
  projectLayer: ReturnType<typeof useFixtureProjectShell>;
  agents: Agent[];
  selectedSession: Session | null;
  attachIntent: 'attach' | 'configure' | null;
  onAttachClose: () => void;
  createOpen: boolean;
  onCreateClose: () => void;
}) {
  return (
    <>
      {sessionDetails.dialog}
      <SessionProjectDialog
        session={projectBinding.target}
        projects={projectLayer.projectShell.projects}
        busy={projectBinding.busy}
        error={projectBinding.error}
        onSave={(projectId) => {
          void projectBinding.save(projectId);
        }}
        onClose={projectBinding.close}
      />
      <FixtureProjectDialogs shell={projectLayer} agents={agents} experience="app" />
      <AppAttachSurface
        isOpen={attachIntent !== null}
        intent={attachIntent ?? 'attach'}
        session={selectedSession}
        agents={agents}
        onClose={onAttachClose}
        onConfirm={onAttachClose}
      />
      <AppCreateSessionSurface
        isOpen={createOpen}
        agents={agents}
        onClose={onCreateClose}
        onCreated={onCreateClose}
      />
    </>
  );
}

/** The route-named App operation state (#3089). */
function useFixtureAppOperations(search: string) {
  const operation = fixtureOperation(search);
  const [createOpen, setCreateOpen] = useState(operation === 'create-session');
  const [attachIntent, setAttachIntent] = useState<'attach' | 'configure' | null>(
    operation === 'attach'
      ? 'attach'
      : operation === 'attach-settings'
        ? 'configure'
        : null,
  );
  return { createOpen, setCreateOpen, attachIntent, setAttachIntent };
}

/** The selected Session, its Agent and the domain state the shell reads. */
function fixtureAppSelection({
  sessions,
  agents,
  selectedId,
  paneCommand,
  staleAgents,
}: {
  sessions: Session[];
  agents: Agent[];
  selectedId: string | null;
  paneCommand: string | null;
  staleAgents: string[];
}) {
  const selectedSession = fixtureSelectedSession(sessions, selectedId, paneCommand);
  const selectedAgent = agents.find(
    (agent) => agent.agent_id === selectedSession?.agent_id,
  );
  const domain = selectedSession
    ? mapDomainState({
        session: selectedSession,
        agent: selectedAgent,
        staleAgentIds: staleAgents,
        clientSessionId: FIXTURE_CLIENT_SESSION_ID,
        attachInFlightId: null,
        attachFailedId: null,
      })
    : null;
  return { selectedSession, selectedAgent, domain };
}

export function FixtureApp() {
  // Read before the stubs below, because one of them is parameterised by it.
  const search = useLocation().search;
  // #2789: rows and the Workspace Session view read the Agent-owned store.

  const projectLayer = useFixtureProjectShell(search);
  const projectBinding = useSessionProjectBinding();
  const { createOpen, setCreateOpen, attachIntent, setAttachIntent } =
    useFixtureAppOperations(search);

  // A capability projection has to be reachable from a fixture to be captured,
  // and until #838 the capsule did not render here at all. This stub is what
  // lets a Peek draw real content offline; installed for the route's lifetime
  // and released on unmount. Nothing emerges by default, so the canonical
  // screenshots are unaffected unless a case opens one. The scenario is the
  // route's input, so it is read here too: this install is the last one for
  // the route and therefore the surface the Git capability actually talks to
  // (#2787's controlled overlap needs it).
  useEffect(() => gitApi.install(fixtureGitSurface(search)), [search]);

  // The conversation stub, one layer down and for the same reason (#1128).
  // Claude Code's Workspace draws a conversation, and the fixture advertised no
  // wire that could serve one — so no conversation surface was reachable from
  // here, and therefore none could be in a golden. Installed for the route's
  // lifetime like the git stub above; the scenario is the route's input, so it
  // is read once at mount rather than tracked, because a fixture route does not
  // change its query without a reload.
  useEffect(() => claudeCodeApi.install(fixtureTranscriptsSurface(search)), [search]);

  // The Environment stub, for the same reachability reason (#1202): the App's
  // Environment navigator/pushed detail can only be captured if the route can
  // open the capability at all. No mount-time gate is needed — the App reaches
  // the capability through the tool strip after mount, not in the first frame.
  useEffect(() => envApi.install(fixtureEnvSurface(search)), [search]);

  // The saved-command stub (#2710): the Commands view reads the same
  // `server.commands.list` owner the product does, so the fixture answers that
  // wire rather than injecting a list into the component.
  useEffect(() => commandsApi.install(fixtureCommandsSurface(search)), [search]);

  const [surface, setSurface] = useState<Surface>('terminal');
  const [tool, setTool] = useState<CapabilityId>('files');

  const {
    searchQuery, setSearchQuery,
    statusFilter, setStatusFilter,
    sortField, sortDirection, toggleSort,
    isSearchActive,
  } = useDashboardFilter();

  // The route's inputs. Each names what the *server* answered rather than a
  // rendering, so the surface below decides what to draw — see
  // `fixtureStaleAgents`, `fixtureSessions`, `fixtureAgents`.
  const staleAgents = fixtureStaleAgents(search);
  // The delivery-unknown notice (#1307 SC-09). Same shape as `staleAgents`
  // above: the route names an input the fixture cannot otherwise be given, and
  // the surface decides what to draw. It has to be reachable from here or it is
  // in no golden image at all — producing a live one needs an Agent to restart
  // mid-session, which no fixture route can do.
  // The other three status inputs (#2621), on the same rule: the route names
  // what the runtime answered and the surface decides what to draw.
  const { historyDegraded, terminalControl, clipboardNotice } = fixtureStatusInputs(search);
  const sessions = useFixtureSessions(search);
  const agents = useMemo(() => fixtureAgents(search), [search]);
  // The shipped details/edit owner (#2875), against the deterministic stub.
  const sessionDetails = useFixtureSessionDetails(agents, staleAgents);
  const connectionStatus = fixtureConnection(search);

  const filteredSessions = useMemo(
    () => filterSessions(sessions, agents, { statusFilter, searchQuery, sortField, sortDirection }),
    [sessions, agents, statusFilter, searchQuery, sortField, sortDirection],
  );

  const selectedId = fixtureSelectedId(search);
  // The reported foreground command: `?pane=claude.exe` is the canonical
  // screen as if the agent had reported Claude Code in the pane.
  const paneCommand = fixturePaneCommand(search);
  const { selectedSession, selectedAgent, domain } = fixtureAppSelection({
    sessions,
    agents,
    selectedId,
    paneCommand,
    staleAgents,
  });

  const sessionProject = fixtureSessionProject(
    selectedSession,
    sessions,
    projectLayer.projectShell,
  );

  const sidebarProps = fixtureSidebarProps({
    agents,
    filteredSessions,
    sessions,
    staleAgents,
    selectedId,
    searchQuery,
    setSearchQuery,
    statusFilter,
    setStatusFilter,
    sortField,
    sortDirection,
    toggleSort,
    isSearchActive,
    connectionStatus,
    domain,
    sessionDetails,
    projectShell: projectLayer.projectShell,
    onAssociateProject: (session) => projectBinding.open(session),
    onCreate: () => setCreateOpen(true),
    onConfigure: () => setAttachIntent('configure'),
  });


  const mainShared = fixtureAppMainShared({
    selectedSession, selectedAgent, agents, domain, tool, setSurface, setTool, sessionProject,
    onCreate: () => setCreateOpen(true),
  });

  const { layer, onLayerChange, onLayerSelect, workspaceAvailable } = useAppLayer({
    selectedId,
    surface,
    active: true,
    onSurfaceChange: setSurface,
    onSelect: () => {},
  });

  return (
    <div
      data-testid="shell"
      data-sf-design="polish"
      data-experience="app"
      className="shell flex h-[100dvh] flex-col bg-background"
    >
      <AppLayout
        layer={layer}
        onLayerChange={onLayerChange}
        sidebarProps={sidebarProps}
        onLayerSelect={onLayerSelect}
        mainShared={mainShared}
        workspaceAvailable={workspaceAvailable}
        projectDetail={
          projectLayer.projectShell.selectedProjectId ? (
            <FixtureAppProjectDetail shell={projectLayer.projectShell} agents={agents} />
          ) : null
        }
        terminal={(chrome: TerminalChrome) => (
          <FixtureTerminal
            chrome={chrome}
            experience="app"
            inputDrop={fixtureInputDrop(search)}
            historyDegraded={historyDegraded}
            terminalControl={terminalControl}
            clipboardNotice={clipboardNotice}
          />
        )}
      />
      <FixtureAppDialogs
        sessionDetails={sessionDetails}
        projectBinding={projectBinding}
        projectLayer={projectLayer}
        agents={agents}
        selectedSession={selectedSession}
        attachIntent={attachIntent}
        onAttachClose={() => setAttachIntent(null)}
        createOpen={createOpen}
        onCreateClose={() => setCreateOpen(false)}
      />
    </div>
  );
}
