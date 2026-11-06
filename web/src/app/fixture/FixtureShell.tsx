import { useEffect, useMemo, useState } from 'react';
import { FixtureTerminal } from '@/app/fixture/FixtureTerminal';
import type { TerminalChrome } from '@/app/ShellMain';
import { FIXTURE_CLIENT_SESSION_ID, FIXTURE_SELECTED_ID } from '@/app/fixture/fixtureData';
import { gitApi } from '@/capabilities/git';
import { mapDomainState } from '@/product/session/model/domainState';
import { WorkspaceRegion } from '@/app/WorkspaceRegion';
import { SessionDetailsDialog } from '@/app/patterns/SessionDetailsDialog';
import { useSessionDetails } from '@/app/useSessionDetails';
import { experienceFromSearch } from '@/app/experienceMode';
import {
  filterSessions,
  type SortDirection,
  type SortField,
  type StatusFilter,
} from '@/app/useDashboard';
import { useMediaQuery } from '@/shared/hooks/useMediaQuery';
import { fixtureAgents } from './fixtureAgents';
import { fixtureConnection } from './fixtureConnection';
import { fixtureGitSurface } from './fixtureGit';
import { fixturePaneCommand } from './fixturePaneCommand';
import { fixtureSessions } from './fixtureSessions';
import { useFixtureSessionMetadata } from './fixtureSessionMetadata';
import { fixtureStaleAgents } from './fixtureStaleAgents';

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
  useFixtureSessionMetadata(search);

  // The same stub `FixtureApp` installs, for the same reason (#838): a
  // capability has to be *reachable* from a fixture to be captured, and the
  // App route had this while the Web route did not — so the Web screen could
  // show the capability entry but not a Peek behind it, which is why #1046's
  // second depth had no Web baseline at all (#1102).
  useEffect(() => gitApi.install(fixtureGitSurface(search)), [search]);

  const agents = useMemo(() => fixtureAgents(search), [search]);
  const sessions = useMemo(() => fixtureSessions(search), [search]);
  const staleAgents = useMemo(() => fixtureStaleAgents(search), [search]);
  const connectionStatus = fixtureConnection(search);
  const experienceOverride = experienceFromSearch(search);

  const [selectedId, setSelectedId] = useState(FIXTURE_SELECTED_ID);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [listOpen, setListOpen] = useState(true);

  const mediaWide = useMediaQuery('(min-width: 1024px)');
  // jsdom has no matchMedia. Component tests mount this fixture as the wide
  // screen they have always described; a real browser uses its actual width.
  const isWide = typeof window.matchMedia === 'function' ? mediaWide : true;

  const filteredSessions = useMemo(
    () =>
      filterSessions(sessions, agents, {
        statusFilter,
        searchQuery,
        sortField,
        sortDirection,
      }),
    [sessions, agents, statusFilter, searchQuery, sortField, sortDirection],
  );
  const isSearchActive = searchQuery.trim().length > 0 || statusFilter !== 'all';

  const selectedSession = sessions.find((session) => session.session_id === selectedId) ?? null;
  const paneCommand = fixturePaneCommand(search);
  const selectedSessionWithCommand =
    selectedSession && paneCommand
      ? { ...selectedSession, foreground_command: paneCommand }
      : selectedSession;
  const selectedAgent = agents.find(
    (agent) => agent.agent_id === selectedSessionWithCommand?.agent_id,
  );
  const sessionDetails = useSessionDetails({
    agents,
    staleAgentIds: staleAgents,
    clientSessionId: FIXTURE_CLIENT_SESSION_ID,
  });
  const domain = selectedSessionWithCommand
    ? mapDomainState({
        session: selectedSessionWithCommand,
        agent: selectedAgent,
        staleAgentIds: [],
        clientSessionId: FIXTURE_CLIENT_SESSION_ID,
        attachInFlightId: null,
        attachFailedId: null,
      })
    : null;

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
          toggleSort={(field) => {
            if (field === sortField) {
              setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
            } else {
              setSortField(field);
              setSortDirection('desc');
            }
          }}
          isSearchActive={isSearchActive}
          selectedSession={selectedSessionWithCommand}
          selectedAgent={selectedAgent}
          domain={domain}
          surface="terminal"
          tool="files"
          fileOps={null}
          onCreate={() => {}}
          onRefresh={() => {}}
          onSelect={(session) => setSelectedId(session.session_id)}
          onConfigure={() => {}}
          onKill={() => {}}
          onViewSessionDetails={(session) => sessionDetails.show(session, false)}
          onEditSessionDetails={(session) => sessionDetails.show(session, true)}
          onSurfaceChange={() => {}}
          onToolChange={() => {}}
          onCloseDrawer={() => setListOpen(false)}
          isWide={isWide}
          experienceOverride={experienceOverride}
          showList={isWide || listOpen}
          showDetail
          onBackToSessions={() => setListOpen(true)}
          connectionStatus={connectionStatus}
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
    </div>
  );
}
