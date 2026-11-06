import { useState } from 'react';
import { mapDomainState } from '@/product/session/model/domainState';
import type { Agent, Session } from '@/types';

export interface SessionDetailsTarget {
  session: Session;
  editing: boolean;
}

/**
 * The row menu's details target, kept outside the selected Session.
 *
 * Viewing or editing one Session must not move the Terminal or Workspace to
 * it. The hook also resolves that target's own DomainState so an offline Agent
 * can disable editing without borrowing the selected Session's state.
 */
export function useSessionDetails({
  agents,
  staleAgentIds,
  clientSessionId,
}: {
  agents: Agent[];
  staleAgentIds: string[];
  clientSessionId: string;
}) {
  const [target, setTarget] = useState<SessionDetailsTarget | null>(null);
  const domain = target
    ? mapDomainState({
        session: target.session,
        agent: agents.find((agent) => agent.agent_id === target.session.agent_id),
        staleAgentIds,
        clientSessionId,
        attachInFlightId: null,
        attachFailedId: null,
      })
    : null;

  return {
    target,
    domain,
    show: (session: Session, editing: boolean) => setTarget({ session, editing }),
    close: () => setTarget(null),
  };
}
