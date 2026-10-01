/**
 * A message, drawn once for every provider.
 *
 * This is the file a second provider never writes. Claude's message and Codex's
 * message are the same component with a different label, because `#1363`'s
 * whole point is that "同一种 AI 对话" must not become several experiences — and
 * the surest way for that to happen is for each adapter to own a renderer.
 *
 * ## The two speakers differ by more than alignment
 *
 * `#1167` settled this and `#1363` keeps it: the assistant's turn is a **reading
 * column** whose Markdown *is* the content, and the user's is a **bounded
 * surface** that stays visually simpler. A surface drawn around prose that
 * already carries its own typography is chrome that says nothing
 * (`PRINCIPLE.md` §6), so the assistant has no bubble.
 *
 * They still share a frame — the identity line — and sharing it is why this is
 * one file: a second copy of the frame would be two places for the meta line to
 * drift.
 *
 * ## Markdown is the single path (SC-09)
 *
 * Both speakers render through `ChatMarkdown`, the #1184 runtime. Neither takes
 * a provider-specific Markdown component, and there is no prop here through
 * which one could be supplied. A pasted fence or a backticked path is ordinary
 * in a *prompt* as well as in an answer, which is why the user's bubble is
 * Markdown rather than `whitespace-pre-wrap`.
 */

import { memo, type ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { formatClockTime } from '@/shared/lib/format'
import { chromeSansRole } from '@/shared/typography/chromeRoles'
import { ChatMarkdown } from '@/shared/markdown/ChatMarkdown'
import type { AIMessageItem } from '../model/conversation'

/**
 * A message's blocks as Markdown source.
 *
 * A block the shared model does not name becomes a marker rather than
 * vanishing: its *position* is the information, and dropping it would render
 * the message as though it had said less than it did — the requirement's
 * "unknown/unsupported content 必须显式降级，不能 silent drop" (SC-10).
 */
function contentOf(item: AIMessageItem): string {
  return item.content
    .map((block) => (block.type === 'text' ? block.text : '_An unreadable block was here._'))
    .join('\n\n')
}

/**
 * The frame both speakers share: identity line, then whichever body.
 *
 * `label` is passed in rather than derived, because the assistant's name is a
 * *provider* fact (`identity.label`) and the user's is not — one of the exactly
 * two things `#1363` allows a provider to vary.
 */
function MessageFrame({
  item,
  align,
  label,
  children,
}: {
  item: AIMessageItem
  /** The user's turn is content-sized; the assistant's stretches. See below. */
  align: 'end' | 'stretch'
  label: string
  children: ReactNode
}) {
  const time = formatClockTime(item.timestamp)
  return (
    <article
      data-testid="conversation-turn"
      data-kind={item.kind}
      data-role={item.role}
      // Claude's turn **stretches** and the user's does not, and that is a
      // correctness difference rather than an alignment preference: in a column
      // flex container `items-start` sizes each item to its *fit-content*
      // width, and a code fence's min-content width is its longest unwrapped
      // line — so a single long line pushes the whole reading column past its
      // container and out of the pane. Stretching gives the column a definite
      // width, so the fence scrolls inside itself the way it is supposed to.
      // The user's bubble stays content-sized, because a short prompt should be
      // a short bubble.
      className={cn(
        'flex min-w-0 flex-col gap-1',
        align === 'end' ? 'items-end' : 'items-stretch',
      )}
    >
      <div className="flex items-baseline gap-2">
        <span className={cn('text-muted-foreground', chromeSansRole('metadata'))}>{label}</span>
        {time ? (
          <time
            dateTime={item.timestamp ?? undefined}
            className={cn('text-muted-foreground', chromeSansRole('metadata'))}
          >
            {time}
          </time>
        ) : null}
      </div>
      {children}
    </article>
  )
}

/**
 * What the user said — a bounded surface, right-aligned (#1120).
 *
 * Memoized so a refresh costs only what changed: the runtime hands back the
 * *same object* for an item whose content did not change (see
 * `runtime/reconcile.ts`), and without `memo` that stable object would buy
 * nothing — every poll would re-parse every message's Markdown.
 */
export const UserMessage = memo(function UserMessage({ item }: { item: AIMessageItem }) {
  return (
    <MessageFrame item={item} align="end" label="You">
      <div
        data-testid="conversation-user-body"
        // The cap is a fraction of the reading column rather than a fixed
        // width, so the bubble keeps its proportion when the surface narrows —
        // and App states a wider fraction without this component changing.
        className={cn(
          'min-w-0 rounded-[var(--radius-surface)] px-3 py-2',
          'bg-[var(--conversation-user-surface)] text-[var(--conversation-user-foreground)]',
        )}
        style={{ maxWidth: 'var(--conversation-bubble-max-width)' }}
      >
        <ChatMarkdown text={contentOf(item)} streaming={false} />
      </div>
    </MessageFrame>
  )
})

/**
 * What the assistant said — a reading column, not a card.
 */
export const AssistantMessage = memo(function AssistantMessage({
  item,
  label,
  streaming = false,
}: {
  item: AIMessageItem
  label: string
  streaming?: boolean
}) {
  return (
    <MessageFrame item={item} align="stretch" label={label}>
      <div
        data-testid="conversation-assistant-body"
        data-streaming={streaming ? 'true' : undefined}
        className="min-w-0 text-sm text-[var(--conversation-assistant-foreground)]"
        style={{ maxWidth: 'var(--conversation-reading-column-max)' }}
      >
        <ChatMarkdown text={contentOf(item)} streaming={streaming} />
      </div>
    </MessageFrame>
  )
})

/**
 * One message, whichever speaker wrote it.
 *
 * The switch lives here rather than at each call site so a surface cannot
 * accidentally draw one speaker differently from another — the same reason the
 * shared model has exactly two roles.
 */
export const ConversationMessage = memo(function ConversationMessage({
  item,
  label,
  streaming = false,
}: {
  item: AIMessageItem
  /** The provider's name for the assistant, e.g. `Claude`. */
  label: string
  streaming?: boolean
}) {
  return item.role === 'user' ? (
    <UserMessage item={item} />
  ) : (
    <AssistantMessage item={item} label={label} streaming={streaming} />
  )
})
