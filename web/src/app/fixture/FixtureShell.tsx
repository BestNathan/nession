import { useEffect, useMemo, useState } from 'react';
import { FixtureTerminal } from '@/app/fixture/FixtureTerminal';
import type { TerminalChrome } from '@/app/ShellMain';
import { FIXTURE_CLIENT_SESSION_ID, FIXTURE_SELECTED_ID } from '@/app/fixture/fixtureData';
import { gitApi } from '@/capabilities/git';
import { mapDomainState } from '@/product/session/model/domainState';
import { WorkspaceRegion } from '@/app/WorkspaceRegion';
import { SessionDetailsDialog } from '@/app/patterns/SessionDetailsDialog';
import { useSessionDetails } from '@/app/useSessionDetails';
import { experienceFromSearch, resolveExperienceMode } from '@/app/experienceMode';
import {
  filterSessions,
  type SortDirection,
  type SortField,
  type StatusFilter,
} from '@/app/useDashboard';
import { useMediaQuery } from '@/shared/hooks/useMediaQuery';
import type { Agent, Session } from '@/types';
import { fixtureAgents } from './fixtureAgents';
import { fixtureConnection } from './fixtureConnection';
import { fixtureGitSurface } from './fixtureGit';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { CapabilityId } from '@/product/capability';
import { fixturePaneCommand } from './fixturePaneCommand';
import { useFixtureSessions } from './useFixtureSessions';
import { useFixtureProjectShell } from './fixtureProjects';
import { FixtureProjectDialogs } from './FixtureProjectDialogs';
import { fixtureStaleAgents } from './fixtureStaleAgents';
import { fixtureOperation } from './fixtureOperations';
import { fixtureSelectedSession } from './fixtureSelectedSession';
import { AttachDialog } from '@/product/session/components/AttachDialog';
import { CreateSessionDialog } from '@/product/session/components/CreateSessionDialog';

/**
 * Canonical Active Terminal screen (#561 Phase 2A): the real shell composition
 * rendered with deterministic data and a static terminal. No network, no auth.
 * Also the Phase 6 baseline source.
 *
 * The fixture is interactive where the shell is: search, status filter, sort
 * and selection are the route's real inputs rather than a screenshot with no
 * controls behind it. Its repository/session data still stays deterministic, so
 * the golden screenshots only move when the shell does.
 *
 * A narrow viewport follows the product's default App experience unless the
 * route asks for Web explicitly (`?experience=web`); that explicit route is
 * what makes the Web overlay drawer a reachable screen at 390px (#2851).
 */
function fixtureDomain(session: Session | null, agent: Agent | undefined) {
  return session
    ? mapDomainState({
        session,
        agent,
        staleAgentIds: [],
        clientSessionId: FIXTURE_CLIENT_SESSION_ID,
        attachInFlightId: null,
        attachFailedId: null,
      })
    : null;
}

/** The route-named operation and whether its surface is open. */
function useFixtureOperation(search: string) {
  const operation = fixtureOperation(search);
  const [open, setOpen] = useState(operation !== null);
  return { operation, open, close: () => setOpen(false) };
}

/** The fixture's route-derived data and experience decision. */
function useFixtureShellData(search: string) {
  const agents = useMemo(() => fixtureAgents(search), [search]);
  const sessions = useFixtureSessions(search);
  const staleAgents = useMemo(() => fixtureStaleAgents(search), [search]);
  const connectionStatus = fixtureConnection(search);
  const experienceOverride = experienceFromSearch(search);
  const operationState = useFixtureOperation(search);
  const mediaWide = useMediaQuery('(min-width: 1024px)');
  // jsdom has no matchMedia. Component tests mount this fixture as the wide
  // screen they have always described; a real browser uses its actual width.
  const isWide = typeof window.matchMedia === 'function' ? mediaWide : true;
  return {
    agents,
    sessions,
    staleAgents,
    connectionStatus,
    experienceOverride,
    operationState,
    isWide,
  };
}

function useFixtureFilteredSessions(
  sessions: Session[],
  agents: Agent[],
  filters: {
    statusFilter: StatusFilter;
    searchQuery: string;
    sortField: SortField;
    sortDirection: SortDirection;
  },
): Session[] {
  const { statusFilter, searchQuery, sortField, sortDirection } = filters;
  return useMemo(
    () =>
      filterSessions(sessions, agents, {
        statusFilter,
        searchQuery,
        sortField,
        sortDirection,
      }),
    [sessions, agents, statusFilter, searchQuery, sortField, sortDirection],
  );
}

/** The fixture route's interactive view state. */
function useFixtureShellUi() {
  const [selectedId, setSelectedId] = useState(FIXTURE_SELECTED_ID);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [listOpen, setListOpen] = useState(true);
  const [surface, setSurface] = useState<Surface>('terminal');
  const [tool, setTool] = useState<CapabilityId>('files');
  return {
    selectedId, setSelectedId,
    searchQuery, setSearchQuery,
    statusFilter, setStatusFilter,
    sortField, setSortField,
    sortDirection, setSortDirection,
    listOpen, setListOpen,
    surface, setSurface,
    tool, setTool,
  };
}

function toggleFixtureSort(
  field: SortField,
  sortField: SortField,
  setSortField: (field: SortField) => void,
  setSortDirection: (update: (direction: SortDirection) => SortDirection) => void,
): void {
  if (field === sortField) {
    setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
  } else {
    setSortField(field);
    setSortDirection(() => 'desc');
  }
}

export function FixtureShell() {
  // FixtureShell is also mounted directly by component tests without a Router.
  // Canonical browser routes use HashRouter (`/#/fixture?pane=...`), so read
  // only the hash query here instead of coupling this deterministic fixture to
  // router context.
  const queryIndex = window.location.hash.indexOf('?');
  const search = queryIndex >= 0 ? window.location.hash.slice(queryIndex) : '';

  // The Session metadata stub (#2789), installed for the route's lifetime so
  // the sidebar's Session rows resolve their display titles through the same
  // product path the shipped app uses. Absent `?sessionMetadata=` is legacy.

  const projectLayer = useFixtureProjectShell(search);

  // The same stub `FixtureApp` installs, for the same reason (#838): a
  // capability has to be *reachable* from a fixture to be captured, and the
  // App route had this while the Web route did not — so the Web screen could
  // show the capability entry but not a Peek behind it, which is why #1046's
  // second depth had no Web baseline at all (#1102).
  useEffect(() => gitApi.install(fixtureGitSurface(search)), [search]);

  const {
    agents,
    sessions,
    staleAgents,
    connectionStatus,
    experienceOverride,
    operationState,
    isWide,
  } = useFixtureShellData(search);

  const {
    selectedId, setSelectedId,
    searchQuery, setSearchQuery,
    statusFilter, setStatusFilter,
    sortField, setSortField,
    sortDirection, setSortDirection,
    listOpen, setListOpen,
    surface, setSurface,
    tool, setTool,
  } = useFixtureShellUi();

  const filteredSessions = useFixtureFilteredSessions(sessions, agents, {
    statusFilter,
    searchQuery,
    sortField,
    sortDirection,
  });
  const isSearchActive = searchQuery.trim().length > 0 || statusFilter !== 'all';

  const selectedSession = fixtureSelectedSession(
    sessions,
    selectedId,
    fixturePaneCommand(search),
  );
  const selectedAgent = agents.find(
    (agent) => agent.agent_id === selectedSession?.agent_id,
  );
  const sessionDetails = useSessionDetails({
    agents,
    staleAgentIds: staleAgents,
    clientSessionId: FIXTURE_CLIENT_SESSION_ID,
  });
  const domain = fixtureDomain(selectedSession, selectedAgent);

  return (
    <div
      data-testid="shell"
      data-sf-design="polish"
      className="shell flex h-[100dvh] flex-col bg-background"
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <WorkspaceRegion
          agents={agents}
          filteredSessions={filteredSessions}
          totalSessionCount={sessions.length}
          staleAgents={staleAgents}
          selectedId={selectedId}
          clientSessionId={FIXTURE_CLIENT_SESSION_ID}
          loadingSessions={false}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          sortField={sortField}
          sortDirection={sortDirection}
          toggleSort={(field) => toggleFixtureSort(field, sortField, setSortField, setSortDirection)}
          isSearchActive={isSearchActive}
          selectedSession={selectedSession}
          selectedAgent={selectedAgent}
          domain={domain}
          surface={surface}
          tool={tool}
          fileOps={null}
          onCreate={() => {}}
          onRefresh={() => {}}
          onSelect={(session) => {
            projectLayer.projectShell.onClose();
            setSelectedId(session.session_id);
          }}
          onConfigure={() => {}}
          onKill={() => {}}
          onViewSessionDetails={(session) => sessionDetails.show(session, false)}
          onEditSessionDetails={(session) => sessionDetails.show(session, true)}
          onSurfaceChange={setSurface}
          onToolChange={setTool}
          onCloseDrawer={() => setListOpen(false)}
          isWide={isWide}
          experienceOverride={experienceOverride}
          showList={isWide || listOpen}
          showDetail
          onBackToSessions={() => setListOpen(true)}
          connectionStatus={connectionStatus}
          projectShell={projectLayer.projectShell}
          terminal={(chrome: TerminalChrome) => (
            <FixtureTerminal chrome={chrome} experience="web" />
          )}
        />
      </div>
      <SessionDetailsDialog
        session={sessionDetails.target?.session ?? null}
        state={sessionDetails.domain}
        editing={sessionDetails.target?.editing ?? false}
        onClose={sessionDetails.close}
      />
      <FixtureProjectDialogs
        shell={projectLayer}
        agents={agents}
        experience={resolveExperienceMode(isWide, experienceOverride)}
      />
      <FixtureOperationDialogs
        operation={operationState.operation}
        open={operationState.open}
        session={selectedSession}
        agents={agents}
        onClose={operationState.close}
      />
    </div>
  );
}

/** The Web attach/create dialogs a #3089 Case opens through the route. */
function FixtureOperationDialogs({
  operation,
  open,
  session,
  agents,
  onClose,
}: {
  operation: ReturnType<typeof fixtureOperation>;
  open: boolean;
  session: Session | null;
  agents: Agent[];
  onClose: () => void;
}) {
  if (operation === null) {
    return null;
  }
  if (operation === 'create-session') {
    return (
      <CreateSessionDialog
        isOpen={open}
        agents={agents}
        preselectedAgentId={null}
        onCreated={onClose}
        onClose={onClose}
      />
    );
  }
  return (
    <AttachDialog
      isOpen={open}
      intent={operation === 'attach-settings' ? 'configure' : 'attach'}
      session={session}
      onClose={onClose}
      onConfirm={onClose}
    />
  );
}
