import { Settings, Trash2 } from 'lucide-react';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AgentChannel, DomainState } from '@/features/sessions/model/domainState';
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

// Row action buttons are always visible below lg (touch-safe drawer rows) and
// hidden behind the group hover/focus/selected reveal at lg+. The hidden state
// is lg:-prefixed so the unprefixed default is visible; the selected override
// must carry the same lg: prefix so tailwind-merge can drop the lg: hidden
// rules (an unprefixed override would keep both classes and lose to the later
// media-query rule in the real cascade, hiding icons on selected rows at lg+).
// jsdom cannot apply group-hover, so tests assert this class composition.
const iconReveal = cn(
  'mt-0.5 size-8 shrink-0 text-muted-foreground',
  'lg:opacity-0 lg:pointer-events-none',
  'lg:group-hover:opacity-100 lg:group-hover:pointer-events-auto',
  'lg:group-focus-within:opacity-100 lg:group-focus-within:pointer-events-auto',
);

export interface SessionItemProps {
  session: Session;
  domain: DomainState;
  agentLabel: string;
  selected: boolean;
  onSelect: (session: Session) => void;
  /** Open the attach-settings (configure) dialog for this session. */
  onConfigure?: (session: Session) => void;
  onKill?: (session: Session) => void;
}

export function SessionItem({
  session,
  domain,
  agentLabel,
  selected,
  onSelect,
  onConfigure,
  onKill,
}: SessionItemProps) {
  return (
    <div
      data-testid="session-item-row"
      data-selected={selected}
      className={cn(
        'group relative flex items-start gap-1 px-[var(--shell-space-3)] py-[var(--shell-space-2)] transition-colors hover:bg-muted/40',
      )}
    >
      {selected ? (
        <span
          data-testid="session-item-selected-bar"
          className="absolute bottom-1 left-0 top-1 rounded-r-sm w-0.5 bg-primary"
          aria-hidden="true"
        />
      ) : null}
      <button
        type="button"
        data-testid={`session-item-${session.session_id}`}
        aria-current={selected ? 'true' : undefined}
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
      {onConfigure ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon"
                variant="ghost"
                data-testid={`session-settings-${session.session_id}`}
                aria-label={`Configure attach settings for ${session.session_name}`}
                className={cn(
                  iconReveal,
                  'hover:text-foreground',
                  selected && 'lg:opacity-100 lg:pointer-events-auto',
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  onConfigure(session);
                }}
              >
                <Settings className="size-4" />
              </Button>
            }
          />
          <TooltipContent side="bottom">Configure attach settings</TooltipContent>
        </Tooltip>
      ) : null}
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
                  iconReveal,
                  'hover:text-destructive',
                  selected && 'lg:opacity-100 lg:pointer-events-auto',
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
