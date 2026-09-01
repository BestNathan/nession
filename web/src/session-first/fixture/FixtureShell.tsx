import { FixtureTerminal } from '@/session-first/fixture/FixtureTerminal';
import {
  FIXTURE_AGENTS,
  FIXTURE_CLIENT_SESSION_ID,
  FIXTURE_SELECTED_ID,
  FIXTURE_SESSIONS,
} from '@/session-first/fixture/fixtureData';
import { mapDomainState } from '@/session-first/domainState';
import { SessionFirstWorkspace } from '@/session-first/SessionFirstWorkspace';

/**
 * Canonical Active Terminal screen (#561 Phase 2A): the real
 * session-first composition rendered with deterministic data and a
 * static terminal. No network, no auth. Also the Phase 6 baseline source.
 */
export function FixtureShell() {
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

  return (
    <div
      data-testid="session-first-shell"
      data-sf-design="polish"
      className="session-first-shell flex h-[100dvh] flex-col bg-background"
    >
      <SessionFirstWorkspace
        agents={FIXTURE_AGENTS}
        filteredSessions={FIXTURE_SESSIONS}
        staleAgents={[]}
        selectedId={selectedId}
        clientSessionId={FIXTURE_CLIENT_SESSION_ID}
        loadingSessions={false}
        searchQuery=""
        setSearchQuery={() => {}}
        statusFilter="all"
        setStatusFilter={() => {}}
        sortField="name"
        sortDirection="desc"
        toggleSort={() => {}}
        isSearchActive={false}
        selectedSession={selectedSession}
        selectedAgent={selectedAgent}
        domain={domain}
        surface="terminal"
        tool="files"
        fileOps={null}
        onCreate={() => {}}
        onRefresh={() => {}}
        onSelect={() => {}}
        onKill={() => {}}
        onSurfaceChange={() => {}}
        onToolChange={() => {}}
        onOpenAgent={() => {}}
        isWide
        showList
        showDetail
        onBackToSessions={() => {}}
        onOpenEnv={() => {}}
        onLegacy={() => {}}
        connectionStatus="connected"
        terminal={<FixtureTerminal />}
      />
    </div>
  );
}
