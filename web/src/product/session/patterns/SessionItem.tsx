import { Settings, Trash2 } from 'lucide-react';
import { formatRelativeTime } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AgentChannel, DomainState } from '@/product/session/model/domainState';
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

/**
 * The row's workload hint — what is running in this Session.
 *
 * `session-item.md` §Workload semantics: "a workload hint can be inferred from
 * foreground process or integration state, but it is not a permanent Session
 * type", and its vocabulary is open-ended ("other TUI / process"). The agent
 * already reports the pane's foreground command on every session update
 * (`session.foreground_command`), so the hint is that value read verbatim
 * rather than a label this pattern invents — which is what keeps it from
 * becoming the "mini capability dashboard" the same section warns against. A
 * mapping table from command to product name would put capability knowledge
 * (`claude` means Claude Code, and `claude.exe` too) inside a navigation row,
 * where it would need to be kept in step with the capability that owns it.
 *
 * `unknown` is the documented fallback for a Session the agent has not reported
 * a command for yet; it is in the doc's vocabulary, and it is honest — the row
 * says it does not know rather than guessing `shell`.
 */
function workloadHint(session: Session): string {
  return session.foreground_command ?? 'unknown';
}

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
      /* Selection is the surface and nothing else. The mockup fills the row
         with `--n-raised` and draws no other cue, and visual-language.md
         forbids stacking background + border + shadow + accent for one
         selection — the accent bar that used to sit here was the second cue. */
      className={cn(
        'group relative flex items-start gap-[var(--shell-space-2)] rounded-[var(--shell-session-row-radius)] px-[var(--shell-space-2)] py-[var(--shell-session-row-pad-y)] transition-colors',
        selected ? 'bg-muted' : 'hover:bg-muted/60',
      )}
    >
      <button
        type="button"
        data-testid={`session-item-${session.session_id}`}
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 flex-col text-left"
        onClick={() => onSelect(session)}
      >
        {/* Both lines truncate rather than wrap. At the mockup's 246px the meta
            line is wider than the column, and a wrapped "ago" reads as a layout
            bug rather than a second line of information; the mockup sets
            `white-space: nowrap` on both for the same reason. */}
        <span
          className={cn(
            'truncate text-[length:var(--shell-session-row-title-font-size)] leading-5',
            selected ? 'font-medium text-foreground' : 'text-[color:var(--text-secondary)]',
          )}
        >
          {session.session_name}
        </span>
        <span
          data-testid="session-item-meta"
          className="truncate font-mono text-[length:var(--shell-session-row-meta-font-size)] leading-4 text-muted-foreground"
        >
          {workloadHint(session)} · {agentLabel} · {formatRelativeTime(session.last_activity)}
        </span>
        {domain.agent.copy !== null && (
          <span
            className={cn(
              'truncate font-mono text-[length:var(--shell-session-row-meta-font-size)] leading-4',
              agentCopyClass(domain.agent.channel),
            )}
          >
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
