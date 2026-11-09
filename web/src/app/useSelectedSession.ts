import { mapDomainState, type DomainState } from '@/product/session/model/domainState';
import type { Agent, Session } from '@/types';

/** The currently selected Session, its Agent, and the derived UI domain. */
export function useSelectedSession({
  sessions,
  agents,
  selectedId,
  staleAgents,
  clientSessionId,
}: {
  sessions: Session[];
  agents: Agent[];
  selectedId: string | null;
  staleAgents: string[];
  clientSessionId: string;
}) {
  const selectedSession = selectedId
    ? sessions.find((session) => session.session_id === selectedId) ?? null
    : null;
  const selectedAgent = selectedSession
    ? agents.find((agent) => agent.agent_id === selectedSession.agent_id) ?? undefined
    : undefined;
  const domain: DomainState | null = selectedSession
    ? mapDomainState({
        session: selectedSession,
        agent: selectedAgent,
        staleAgentIds: staleAgents,
        clientSessionId,
        attachInFlightId: null,
        attachFailedId: null,
      })
    : null;
  return { selectedSession, selectedAgent, domain };
}
