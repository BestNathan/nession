import { agentDisplayName, formatRelativeTime } from '@/lib/format';
import { ConnectionStatus } from '@/session-first/patterns/ConnectionStatus';
import type { DomainState } from '@/session-first/domainState';
import type { Agent } from '@/types';

export interface AgentDetailProps {
  agent: Agent;
  state: DomainState;
}

export function AgentDetail({ agent, state }: AgentDetailProps) {
  const name = agentDisplayName(agent);
  const metadata = agent.metadata;

  return (
    <div data-testid="agent-detail" className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-sm font-semibold">{name}</h2>
        <p className="text-sm text-muted-foreground">{agent.hostname}</p>
      </div>

      <ConnectionStatus state={state} />

      <dl className="grid gap-2 text-sm">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">ID</dt>
          <dd>{agent.agent_id}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Address</dt>
          <dd>{agent.ip_address}:{agent.port}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Last heartbeat</dt>
          <dd>{formatRelativeTime(agent.last_heartbeat)}</dd>
        </div>
        {metadata && (
          <>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">tmux</dt>
              <dd>{metadata.tmux_version}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">OS</dt>
              <dd>{metadata.os_version}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">nession</dt>
              <dd>{metadata.nession_version}</dd>
            </div>
            {metadata.image_tag && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Image</dt>
                <dd>{metadata.image_tag}</dd>
              </div>
            )}
          </>
        )}
      </dl>
    </div>
  );
}
