import { WorkspaceShell } from '@/session-first/workspace/WorkspaceShell';
import type { WorkspaceContext } from '@/session-first/workspace/toolTypes';
import {
  FIXTURE_AGENTS,
  FIXTURE_SELECTED_ID,
  FIXTURE_SESSIONS,
} from '@/session-first/fixture/fixtureData';
import { mapDomainState } from '@/session-first/domainState';
import { fixtureFileOps } from './fixtureFileOps';

/**
 * Canonical Workspace surface (#561 Phase 2B): the real plugin shell with
 * deterministic files data, no network. Phase 6 baseline source.
 */
export function FixtureWorkspace() {
  const selectedSession =
    FIXTURE_SESSIONS.find((s) => s.session_id === FIXTURE_SELECTED_ID) ?? null;
  const selectedAgent = FIXTURE_AGENTS.find(
    (a) => a.agent_id === selectedSession?.agent_id,
  );
  const domain = selectedSession
    ? mapDomainState({
        session: selectedSession,
        agent: selectedAgent,
        staleAgentIds: [],
        clientSessionId: FIXTURE_SELECTED_ID,
        attachInFlightId: null,
        attachFailedId: null,
      })
    : null;
  const ctx: WorkspaceContext = {
    session: selectedSession,
    agent: selectedAgent,
    domain,
    fileOps: fixtureFileOps(),
    experience: 'web',
    onToolChange: () => {},
  };
  return (
    <div
      data-testid="session-first-shell"
      className="session-first-shell flex h-[100dvh] flex-col bg-background"
    >
      <WorkspaceShell ctx={ctx} activeTool="files" />
    </div>
  );
}
