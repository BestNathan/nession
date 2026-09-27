import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AppLayout } from '@/app/experiences/app/AppLayout';
import { useAppLayer } from '@/app/experiences/app/useAppLayer';
import { filterSessions } from '@/app/useDashboard';
import { useDashboardFilter } from '@/app/useDashboardFilter';
import { mapDomainState } from '@/product/session/model/domainState';
import { FixtureTerminal } from '@/app/fixture/FixtureTerminal';
import { FIXTURE_CLIENT_SESSION_ID } from '@/app/fixture/fixtureData';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { CapabilityId } from '@/product/capability';
import { claudeCodeApi } from '@/capabilities/claude-code';
import { gitApi } from '@/capabilities/git';
import { fixtureAgents } from './fixtureAgents';
import { fixtureConnection } from './fixtureConnection';
import { fixtureConversationSurface } from './fixtureConversation';
import { fixtureFileOps } from './fixtureFileOps';
import { fixtureGitSurface } from './fixtureGit';
import { fixtureSelectedId } from './fixtureSelection';
import { fixtureSessions } from './fixtureSessions';
import { fixtureStaleAgents } from './fixtureStaleAgents';

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
export function FixtureApp() {
  // Read before the stubs below, because one of them is parameterised by it.
  const search = useLocation().search;

  // A capability projection has to be reachable from a fixture to be captured,
  // and until #838 the capsule did not render here at all. This stub is what
  // lets a Signal draw real content offline; installed for the route's lifetime
  // and released on unmount. Nothing emerges by default, so the canonical
  // screenshots are unaffected unless a case opens one.
  useEffect(() => gitApi.install(fixtureGitSurface('')), []);

  // The conversation stub, one layer down and for the same reason (#1128).
  // Claude Code's Workspace draws a conversation, and the fixture advertised no
  // wire that could serve one — so no conversation surface was reachable from
  // here, and therefore none could be in a golden. Installed for the route's
  // lifetime like the git stub above; the scenario is the route's input, so it
  // is read once at mount rather than tracked, because a fixture route does not
  // change its query without a reload.
  useEffect(() => claudeCodeApi.install(fixtureConversationSurface(search)), [search]);

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
  const sessions = useMemo(() => fixtureSessions(search), [search]);
  const agents = useMemo(() => fixtureAgents(search), [search]);
  const connectionStatus = fixtureConnection(search);

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

  const selectedId = fixtureSelectedId(search);
  const selectedSession =
    sessions.find((s) => s.session_id === selectedId) ?? null;
  const selectedAgent = agents.find(
    (a) => a.agent_id === selectedSession?.agent_id,
  );
  const domain = selectedSession
    ? mapDomainState({
        session: selectedSession,
        agent: selectedAgent,
        // The same input the rows are given (`useShellState` hands the product's
        // footer the whole stale list): a footer that stayed healthy while the
        // list said otherwise would be a disagreement the product does not have.
        staleAgentIds: staleAgents,
        clientSessionId: FIXTURE_CLIENT_SESSION_ID,
        attachInFlightId: null,
        attachFailedId: null,
      })
    : null;

  const sidebarProps = {
    agents,
    filteredSessions,
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
    onCreate: () => {},
    onRefresh: () => {},
    onConfigure: () => {},
    onKill: () => {},
  };

  const mainShared = {
    selectedSession,
    selectedAgent,
    agents,
    domain,
    tool,
    fileOps: fixtureOps,
    connectionStatus,
    onSurfaceChange: setSurface,
    onToolChange: setTool,
    onOpenAgent: () => {},
    // Inert, like every other handler here: the home's "New Session" opens the
    // product's dialog, and a fixture that opened one would be asserting on a
    // flow it does not own (#1082).
    onCreate: () => {},
  };

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
        terminal={(chrome) => (
          <FixtureTerminal chrome={chrome} experience="app" />
        )}
      />
    </div>
  );
}
