import { useEffect, useState } from 'react';
import { AppLayout } from '@/app/experiences/app/AppLayout';
import { useAppLayer } from '@/app/experiences/app/useAppLayer';
import { mapDomainState } from '@/product/session/model/domainState';
import { FixtureTerminal } from '@/app/fixture/FixtureTerminal';
import {
  FIXTURE_AGENTS,
  FIXTURE_CLIENT_SESSION_ID,
  FIXTURE_SELECTED_ID,
  FIXTURE_SESSIONS,
} from '@/app/fixture/fixtureData';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { CapabilityId } from '@/product/capability';
import { gitApi } from '@/capabilities/git';
import { fixtureFileOps } from './fixtureFileOps';
import { fixtureGitSurface } from './fixtureGit';

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

  const selectedId = FIXTURE_SELECTED_ID;
  const selectedSession =
    FIXTURE_SESSIONS.find((s) => s.session_id === selectedId) ?? null;
  const selectedAgent = FIXTURE_AGENTS.find(
    (a) => a.agent_id === selectedSession?.agent_id,
  );
  const domain = selectedSession
    ? mapDomainState({
        session: selectedSession,
        agent: selectedAgent,
        staleAgentIds: [],
        clientSessionId: FIXTURE_CLIENT_SESSION_ID,
        attachInFlightId: null,
        attachFailedId: null,
      })
    : null;

  const sidebarProps = {
    agents: FIXTURE_AGENTS,
    filteredSessions: FIXTURE_SESSIONS,
    staleAgents: [],
    selectedId,
    clientSessionId: FIXTURE_CLIENT_SESSION_ID,
    loadingSessions: false,
    searchQuery: '',
    setSearchQuery: () => {},
    statusFilter: 'all' as const,
    setStatusFilter: () => {},
    sortField: 'name' as const,
    sortDirection: 'desc' as const,
    toggleSort: () => {},
    isSearchActive: false,
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
  };

  const { layer, onLayerChange, onLayerSelect } = useAppLayer({
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
        terminal={(chrome) => <FixtureTerminal chrome={chrome} />}
      />
    </div>
  );
}
