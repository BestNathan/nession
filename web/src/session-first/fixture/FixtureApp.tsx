import { useState } from 'react';
import { TerminalScrollOverlay } from '@/components/TerminalScrollOverlay';
import {
  AppSpatialShell,
  type SpatialPageIndex,
} from '@/session-first/app-spatial/AppSpatialShell';
import { mapDomainState } from '@/session-first/domainState';
import { FixtureTerminal } from '@/session-first/fixture/FixtureTerminal';
import {
  FIXTURE_AGENTS,
  FIXTURE_CLIENT_SESSION_ID,
  FIXTURE_SELECTED_ID,
  FIXTURE_SESSIONS,
} from '@/session-first/fixture/fixtureData';
import { SessionFirstMain } from '@/session-first/SessionFirstMain';
import { SessionFirstSidebar } from '@/session-first/SessionFirstSidebar';
import type { Surface } from '@/session-first/patterns/SessionHeader';
import type { WorkspaceToolId } from '@/session-first/workspace/toolTypes';
import { fixtureFileOps } from './fixtureFileOps';

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
  const [spatialIndex, setSpatialIndex] = useState<SpatialPageIndex>(1);
  // Surface derives from the pager position — page 2 is the workspace,
  // every other position is the terminal page.
  const surface: Surface = spatialIndex === 2 ? 'workspace' : 'terminal';
  const [tool, setTool] = useState<WorkspaceToolId>('files');

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
    onCreate: () => {},
    onRefresh: () => {},
    onKill: () => {},
    onOpenEnv: () => {},
    onLegacy: () => {},
  };

  const mainShared = {
    selectedSession,
    selectedAgent,
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
      data-testid="session-first-shell"
      data-sf-design="polish"
      className="session-first-shell flex h-[100dvh] flex-col bg-background"
    >
      <AppSpatialShell
        index={spatialIndex}
        onIndexChange={setSpatialIndex}
        sessions={
          <SessionFirstSidebar
            {...sidebarProps}
            onSelect={() => setSpatialIndex(1)}
          />
        }
        terminal={
          <div className="flex h-full min-h-0 flex-col">
            <SessionFirstMain
              {...mainShared}
              surface={surface}
              showWorkspace={false}
              experience="app"
              onOpenDrawer={() => setSpatialIndex(0)}
              onOpenWorkspace={() => setSpatialIndex(2)}
              terminal={
                <div className="relative h-full">
                  <FixtureTerminal />
                  <TerminalScrollOverlay
                    onScrollPages={() => {}}
                    onScrollToBottom={() => {}}
                  />
                </div>
              }
            />
          </div>
        }
        workspace={
          <div className="flex h-full min-h-0 flex-col">
            <SessionFirstMain
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
