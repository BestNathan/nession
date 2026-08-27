import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AgentChannel, DomainState } from '@/session-first/domainState';
import type { Session } from '@/types';

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

export interface SessionItemProps {
  session: Session;
  domain: DomainState;
  agentLabel: string;
  selected: boolean;
  onSelect: (session: Session) => void;
}

export function SessionItem({
  session,
  domain,
  agentLabel,
  selected,
  onSelect,
}: SessionItemProps) {
  return (
    <button
      type="button"
      data-testid={`session-item-${session.session_id}`}
      className={cn(
        'flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors',
        selected && 'bg-accent',
      )}
      onClick={() => onSelect(session)}
    >
      <span className="font-medium">{session.session_name}</span>
      <span className="text-muted-foreground text-xs">
        shell · {agentLabel} · {formatRelativeTime(session.last_activity)}
      </span>
      {domain.agent.copy !== null && (
        <span className={cn('text-xs', agentCopyClass(domain.agent.channel))}>
          {domain.agent.copy}
        </span>
      )}
    </button>
  );
}
