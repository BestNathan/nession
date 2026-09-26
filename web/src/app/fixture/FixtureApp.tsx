import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AppLayout } from '@/app/experiences/app/AppLayout';
import { useAppLayer } from '@/app/experiences/app/useAppLayer';
import { filterSessions } from '@/app/useDashboard';
import { useDashboardFilter } from '@/app/useDashboardFilter';
import { mapDomainState } from '@/product/session/model/domainState';
import { FixtureTerminal } from '@/app/fixture/FixtureTerminal';
import {
  FIXTURE_AGENTS,
  FIXTURE_CLIENT_SESSION_ID,
  FIXTURE_SESSIONS,
} from '@/app/fixture/fixtureData';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { CapabilityId } from '@/product/capability';
import { gitApi } from '@/capabilities/git';
import { fixtureFileOps } from './fixtureFileOps';
import { fixtureGitSurface } from './fixtureGit';
import { fixtureSelectedId } from './fixtureSelection';
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
  // A capability projection has to be reachable from a fixture to be captured,
  // and until #838 the capsule did not render here at all. This stub is what
  // lets a Signal draw real content offline; installed for the route's lifetime
  // and released on unmount. Nothing emerges by default, so the canonical
  // screenshots are unaffected unless a case opens one.
  useEffect(() => gitApi.install(fixtureGitSurface('')), []);

  const [surface, setSurface] = useState<Surface>('terminal');
  const [tool, setTool] = useState<CapabilityId>('files');

  const {
    searchQuery, setSearchQuery,
    statusFilter, setStatusFilter,
    sortField, sortDirection, toggleSort,
    isSearchActive,
  } = useDashboardFilter();

  const filteredSessions = useMemo(
    () =>
      filterSessions(FIXTURE_SESSIONS, FIXTURE_AGENTS, {
        statusFilter,
        searchQuery,
        sortField,
        sortDirection,
      }),
    [statusFilter, searchQuery, sortField, sortDirection],
  );

  const search = useLocation().search;

  // The route's Session-list input. Nothing here can produce staleness (it takes
  // a refresh getting no answer), so the parameter names the input — see
  // `fixtureStaleAgents`.
  const staleAgents = fixtureStaleAgents(search);

  const selectedId = fixtureSelectedId(search);
  const selectedSession =
    FIXTURE_SESSIONS.find((s) => s.session_id === selectedId) ?? null;
  const selectedAgent = FIXTURE_AGENTS.find(
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
    agents: FIXTURE_AGENTS,
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
    connectionStatus: 'connected' as const,
    domain,
    onCreate: () => {},
    onRefresh: () => {},
    onConfigure: () => {},
    onKill: () => {},
  };

  const mainShared = {
    selectedSession,
    selectedAgent,
    agents: FIXTURE_AGENTS,
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
