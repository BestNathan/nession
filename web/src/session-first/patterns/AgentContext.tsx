import { cn } from '@/lib/utils';
import type { AgentChannel, DomainState } from '@/session-first/domainState';

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

export function AgentContext({ agentLabel, state, onOpenAgent }: AgentContextProps) {
  const online = state.agent.channel === 'online';

  return (
    <button
      type="button"
      data-testid="agent-context"
      className="text-sm"
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
