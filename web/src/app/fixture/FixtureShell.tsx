import { FixtureTerminal } from '@/app/fixture/FixtureTerminal';
import {
  FIXTURE_AGENTS,
  FIXTURE_CLIENT_SESSION_ID,
  FIXTURE_SELECTED_ID,
  FIXTURE_SESSIONS,
} from '@/app/fixture/fixtureData';
import { mapDomainState } from '@/product/session/model/domainState';
import { WorkspaceRegion } from '@/app/WorkspaceRegion';

/**
 * Canonical Active Terminal screen (#561 Phase 2A): the real
 * shell composition rendered with deterministic data and a
 * static terminal. No network, no auth. Also the Phase 6 baseline source.
 *
 * Above `lg` the shell is two columns, so the canonical wide screen shows the
 * sidebar in its own column. It used to render a forced-open overlay drawer on
 * top of the content, which is a state the shipped shell no longer has at this
 * width — the baseline moves with it rather than preserving a screen no user
 * can reach (docs/design/migration.md).
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
      data-testid="shell"
      data-sf-design="polish"
      className="shell flex h-[100dvh] flex-col bg-background"
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <WorkspaceRegion
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
          onConfigure={() => {}}
          onKill={() => {}}
          onSurfaceChange={() => {}}
          onToolChange={() => {}}
          onCloseDrawer={() => {}}
          isWide
          showList
          showDetail
          onBackToSessions={() => {}}
          connectionStatus="connected"
          terminal={(chrome) => (
            <FixtureTerminal chrome={chrome} experience="web" />
          )}
        />
      </div>
    </div>
  );
}
