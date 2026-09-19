import { useEffect, useState } from 'react';
import {
  AppSpatialShell,
  type SpatialPageIndex,
} from '@/app/experiences/app/AppSpatialShell';
import { mapDomainState } from '@/product/session/model/domainState';
import { FixtureTerminal } from '@/app/fixture/FixtureTerminal';
import {
  FIXTURE_AGENTS,
  FIXTURE_CLIENT_SESSION_ID,
  FIXTURE_SELECTED_ID,
  FIXTURE_SESSIONS,
} from '@/app/fixture/fixtureData';
import { ShellMain } from '@/app/ShellMain';
import { Sidebar } from '@/app/Sidebar';
import type { Surface } from '@/app/patterns/SessionHeader';
import type { CapabilityId } from '@/product/capability';
import { gitApi } from '@/capabilities/git';
import { fixtureFileOps } from './fixtureFileOps';
import { fixtureGitSurface } from './fixtureGit';

// Module-stable — the stub is immutable and stateless (same pattern as
// FixtureWorkspace's fixtureOps).
const fixtureOps = fixtureFileOps();

/**
 * Canonical App Active Terminal screen (#561 Phase 2C): the spatial
 * 3-page pager at 390×844 — single-row App header, static terminal with
 * the app scroll overlay, files plugin app layout, deterministic data.
 * No network. Also the Phase 6 baseline source.
 */
export function FixtureApp() {
  // A capability projection has to be reachable from a fixture to be captured,
  // and until #838 the capsule did not render here at all. This stub is what
  // lets a Signal draw real content offline; installed for the route's lifetime
  // and released on unmount. Nothing emerges by default, so the canonical
  // screenshots are unaffected unless a case opens one.
  useEffect(() => gitApi.install(fixtureGitSurface('')), []);

  const [spatialIndex, setSpatialIndex] = useState<SpatialPageIndex>(1);
  // Surface derives from the pager position — page 2 is the workspace,
  // every other position is the terminal page.
  const surface: Surface = spatialIndex === 2 ? 'workspace' : 'terminal';
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
    onSurfaceChange: (s: Surface) =>
      setSpatialIndex(s === 'workspace' ? 2 : 1),
    onToolChange: setTool,
    onOpenAgent: () => {},
  };

  return (
    <div
      data-testid="shell"
      data-sf-design="polish"
      data-experience="app"
      className="shell flex h-[100dvh] flex-col bg-background"
    >
      <AppSpatialShell
        index={spatialIndex}
        onIndexChange={setSpatialIndex}
        sessions={
          <Sidebar
            {...sidebarProps}
            onSelect={() => setSpatialIndex(1)}
          />
        }
        terminal={
          <div className="flex h-full min-h-0 flex-col">
            <ShellMain
              {...mainShared}
              surface={surface}
              showWorkspace={false}
              experience="app"
              onOpenDrawer={() => setSpatialIndex(0)}
              onOpenWorkspace={() => setSpatialIndex(2)}
              terminal={(chrome) => (
                <div className="relative h-full">
                  <FixtureTerminal chrome={chrome} />
                </div>
              )}
            />
          </div>
        }
        workspace={
          <div className="flex h-full min-h-0 flex-col">
            <ShellMain
              {...mainShared}
              surface={surface}
              showTerminal={false}
              experience="app"
            />
          </div>
        }
      />
    </div>
  );
}
