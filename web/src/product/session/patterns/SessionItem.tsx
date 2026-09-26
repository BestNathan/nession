import { MoreHorizontal, Settings, Trash2 } from 'lucide-react';
import { formatRelativeTime } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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

// The row's secondary actions have two presentations, and the breakpoint owns
// the switch — not React, which cannot read one.
//
// At lg+ they are the inline icons below: hidden until group hover/focus, and
// held visible on the selected row. That reveal is the Web shell's shipped
// behaviour and this change does not touch it.
//
// Below lg they are one `…` trigger (`SessionRowActionsMenu`). There is no
// hover down there — that band is the App's Sessions surface and the Web
// shell's narrow drawer — so icons visible by default sit in the row
// permanently, as peers of the row's own tap target. `session-item.md` answers
// both halves ("Secondary actions: Web hover/focus/overflow, App
// overflow/swipe/context action") and lists exactly this state as an
// anti-pattern ("Permanent destructive controls").
//
// So both presentations are in the DOM and the media query picks one.
// `display: none` keeps the undisplayed one out of the accessibility tree and
// the tab order, so only one is ever reachable. The duplicate markup is asked
// for by the switch being a breakpoint: choosing in React would need a prop
// threaded from the App down through SessionList, and the App and Web share
// this component.
//
// The hiding rule has to stay `lg:`-prefixed so the unprefixed default is
// visible, and the selected override has to carry that same prefix, or
// tailwind-merge keeps both classes and the later media-query rule wins the
// real cascade — which would hide the icons on selected rows at lg+. jsdom
// applies neither media query nor group-hover, so tests assert this class
// composition.
const iconReveal = cn(
  'mt-0.5 size-8 shrink-0 text-muted-foreground',
  'max-lg:hidden',
  'lg:opacity-0 lg:pointer-events-none',
  'lg:group-hover:opacity-100 lg:group-hover:pointer-events-auto',
  'lg:group-focus-within:opacity-100 lg:group-focus-within:pointer-events-auto',
);

/**
 * The two row actions as one `…` menu — the sub-`lg` presentation.
 *
 * `Button`'s `icon` size is `--control-md`, and that is the point rather than a
 * default left in place: under the Web shell that token is 32px, inside the App
 * it is 44px — the App's own touch floor (`experience.app.touchTarget.min`).
 * So the trigger is the experience's control band without this row restating a
 * number, and it is the one control the App row now exposes as a tap target
 * (the inline icons it replaces hardcode `size-8` in both experiences).
 *
 * The `…` is the disclosure `session-item.md` prefers for App; swipe and
 * long-press are the alternatives it also allows and neither has a keyboard
 * path. The popup is `base-ui`'s menu, so the trigger carries its own
 * accessible name and the whole thing is operable from the keyboard.
 */
function SessionRowActionsMenu({
  session,
  onConfigure,
  onKill,
}: {
  session: Session;
  onConfigure?: (session: Session) => void;
  onKill?: (session: Session) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            size="icon"
            variant="ghost"
            data-testid={`session-actions-${session.session_id}`}
            aria-label={`Session actions for ${session.session_name}`}
            className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground lg:hidden"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-48">
        {onConfigure ? (
          <DropdownMenuItem
            data-testid={`session-actions-settings-${session.session_id}`}
            onClick={() => onConfigure(session)}
          >
            <Settings />
            Attach settings
          </DropdownMenuItem>
        ) : null}
        {onKill ? (
          <DropdownMenuItem
            variant="destructive"
            data-testid={`session-actions-kill-${session.session_id}`}
            onClick={() => onKill(session)}
          >
            <Trash2 />
            Kill session
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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

/**
 * The row's meta line: `{workload} · {agent} · {recency}`, three slots in two
 * families (#1050 stage 4).
 *
 * The workload hint is the pane's `foreground_command` — a command name, which
 * is squarely what monospace is for ("terminal text, paths, commands, code").
 * The other two are not: the node's name and the recency are the Metadata role,
 * which `visual-language.md` names as "Agent/location, recency, status
 * details". One mono string made a third of the line claim the line was
 * technical, and it was the third a reader scans for a name.
 *
 * The hint keeps its mono when the command is unreported and the slot reads
 * `unknown`: that is the workload slot's documented value rather than a word
 * about the row, so the family must not flip with the data — and the least
 * informative row would be the one that stopped looking like a workload.
 *
 * A family change, not a structural one: this is still one element with one
 * testid, and its `textContent` is unchanged, which is what the row's tests and
 * `session-lifecycle.spec.ts` assert on.
 */
function SessionMetaLine({
  session,
  agentLabel,
}: {
  session: Session;
  agentLabel: string;
}) {
  return (
    <span
      data-testid="session-item-meta"
      className="truncate text-[length:var(--shell-session-row-meta-font-size)] leading-4 text-muted-foreground"
    >
      <span data-testid="session-item-workload" className="font-mono">
        {workloadHint(session)}
      </span>
      {' · '}
      {agentLabel}
      {' · '}
      {formatRelativeTime(session.last_activity)}
    </span>
  );
}

/**
 * One Session row.
 *
 * **Typography (#1050 stage 4).** The title was always product text; the meta
 * line's families are documented on `SessionMetaLine`; and the conditional agent
 * copy below is continuity state about infrastructure, so it is product text
 * too — typography must not be what changes when the state does, colour already
 * says it.
 */
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
        <SessionMetaLine session={session} agentLabel={agentLabel} />
        {domain.agent.copy !== null && (
          /* Product text too: continuity state about infrastructure, and the
             degraded reading of the agent slot two lines up. */
          <span
            className={cn(
              'truncate text-[length:var(--shell-session-row-meta-font-size)] leading-4',
              agentCopyClass(domain.agent.channel),
            )}
          >
            {domain.agent.copy}
          </span>
        )}
      </button>
      {onConfigure || onKill ? (
        <SessionRowActionsMenu
          session={session}
          onConfigure={onConfigure}
          onKill={onKill}
        />
      ) : null}
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
