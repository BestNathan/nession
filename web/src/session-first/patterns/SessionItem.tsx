import { Trash2 } from 'lucide-react';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
  onKill?: (session: Session) => void;
}

export function SessionItem({
  session,
  domain,
  agentLabel,
  selected,
  onSelect,
  onKill,
}: SessionItemProps) {
  return (
    <div
      data-testid="session-item-row"
      className={cn(
        'group flex items-start gap-1 rounded-lg px-[var(--sf-space-3)] py-[var(--sf-space-2)] transition-colors',
        selected && 'bg-muted',
      )}
    >
      <button
        type="button"
        data-testid={`session-item-${session.session_id}`}
        className="flex min-w-0 flex-1 flex-col gap-0.5 py-1 text-left text-sm"
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
      {onKill ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon"
                variant="ghost"
                data-testid={`session-kill-${session.session_id}`}
                aria-label="Kill session"
                className={cn(
                  'mt-0.5 size-8 shrink-0 text-muted-foreground hover:text-destructive',
                  'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto',
                  'group-focus-within:opacity-100 group-focus-within:pointer-events-auto',
                  selected && 'opacity-100 pointer-events-auto',
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  onKill(session);
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            }
          />
          <TooltipContent side="bottom">Kill session</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
