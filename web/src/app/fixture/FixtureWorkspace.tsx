import { useLocation } from 'react-router-dom';
import { WorkspaceShell } from '@/app/workspace/WorkspaceShell';
import { fixtureCapabilityFacts } from '@/app/fixture/fixtureCapabilityFacts';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import {
  FIXTURE_AGENTS,
  FIXTURE_SELECTED_ID,
  FIXTURE_SESSIONS,
} from '@/app/fixture/fixtureData';
import { mapDomainState } from '@/product/session/model/domainState';
import { fixtureFileOps } from './fixtureFileOps';

// Module-stable — the stub is immutable and stateless, so a single instance
// is safe to share across renders (same pattern as fixtureRoute).
const fixtureOps = fixtureFileOps();

/**
 * Canonical Workspace surface (#561 Phase 2B): the real plugin shell with
 * deterministic files data, no network. Phase 6 baseline source.
 */
export function FixtureWorkspace() {
  // Route parameters express session observations; without them the fixture is
  // exactly the canonical screen the golden screenshots capture.
  const facts = fixtureCapabilityFacts(useLocation().search);
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
    agents: FIXTURE_AGENTS,
    domain,
    fileOps: fixtureOps,
    experience: 'web',
    facts,
    onToolChange: () => {},
  };
  return (
    <div
      data-testid="shell"
      data-sf-design="polish"
      className="shell flex h-[100dvh] flex-col bg-background"
    >
      <WorkspaceShell ctx={ctx} activeCapabilityId="files" />
    </div>
  );
}
