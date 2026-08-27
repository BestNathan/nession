import type { Agent, Session } from '../types';

export type AgentChannel = 'online' | 'offline' | 'error';
export type SessionChannel = 'active' | 'exited' | 'unknown';
export type AttachmentChannel = 'attached' | 'attaching' | 'detached' | 'failed';

export interface ChannelView<C extends string> {
  channel: C;
  copy: string | null;
}

export interface DomainState {
  agent: ChannelView<AgentChannel>;
  session: ChannelView<SessionChannel>;
  attachment: ChannelView<AttachmentChannel>;
}

export interface MapDomainStateInput {
  session: Session;
  agent: Agent | undefined;
  staleAgentIds: Iterable<string>;
  clientSessionId: string;
  attachInFlightId: string | null;
  attachFailedId: string | null;
}

export function mapDomainState(input: MapDomainStateInput): DomainState {
  const stale = new Set(input.staleAgentIds);
  const sid = input.session.session_id;

  let agentChannel: AgentChannel = 'offline';
  let agentCopy: string | null = 'Agent unreachable';
  if (input.agent) {
    if (stale.has(input.agent.agent_id)) {
      agentChannel = input.agent.status === 'offline' ? 'offline' : 'error';
      agentCopy = 'Agent did not respond';
    } else if (input.agent.status === 'online') {
      agentChannel = 'online';
      agentCopy = null;
    } else if (input.agent.status === 'offline') {
      agentChannel = 'offline';
      agentCopy = 'Agent offline';
    } else {
      agentChannel = 'error';
      agentCopy = 'Agent error';
    }
  }

  let sessionChannel: SessionChannel = 'unknown';
  if (input.agent) {
    sessionChannel = input.session.status === 'zombie' ? 'exited' : 'active';
  }

  let attachment: AttachmentChannel = 'detached';
  if (input.attachFailedId === sid) {
    attachment = 'failed';
  } else if (input.attachInFlightId === sid) {
    attachment = 'attaching';
  } else if (input.clientSessionId === sid) {
    attachment = 'attached';
  }

  return {
    agent: { channel: agentChannel, copy: agentCopy },
    session: { channel: sessionChannel, copy: null },
    attachment: {
      channel: attachment,
      copy: attachment === 'failed' ? 'Attach failed' : null,
    },
  };
}
