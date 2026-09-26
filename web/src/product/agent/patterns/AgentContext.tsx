import { cn } from '@/shared/lib/utils';
import type { AgentChannel, DomainState } from '@/product/session/model/domainState';

function agentCopyClass(channel: AgentChannel): string {
  switch (channel) {
    case 'offline':
      return 'text-agent-offline';
    case 'error':
      return 'text-agent-error';
    case 'online':
      return '';
  }
}

export interface AgentContextProps {
  agentLabel: string;
  state: DomainState;
  onOpenAgent: () => void;
}

/**
 * The agent chip: the node's name, and — when the node is not reachable — its
 * continuity copy.
 *
 * Set in the product face (#1050 stage 4). Both of its members are the Metadata
 * role ("Agent/location", plus the status detail below it), and the same two
 * values are product text wherever else they appear: the Sessions row's agent
 * slot and its degraded copy line. The `font-mono` it carried came from the same
 * reading of "a node name is infrastructure identity" that
 * `SidebarAgents` and the `shell.nodeFontSize` description carried.
 *
 * No consumer renders this today — the Web header that owned it went with #748
 * — so nothing here is verified by a baseline; the change keeps the component
 * from being the place a mono node label gets reintroduced from.
 */
export function AgentContext({ agentLabel, state, onOpenAgent }: AgentContextProps) {
  const online = state.agent.channel === 'online';

  return (
    <button
      type="button"
      data-testid="agent-context"
      className="truncate text-xs"
      onClick={() => onOpenAgent()}
    >
      {online ? (
        <span className="text-muted-foreground">{agentLabel}</span>
      ) : (
        <>
          <span className="font-medium">{agentLabel}</span>
          {state.agent.copy !== null && (
            <span className={cn('ml-1.5', agentCopyClass(state.agent.channel))}>
              {state.agent.copy}
            </span>
          )}
        </>
      )}
    </button>
  );
}
