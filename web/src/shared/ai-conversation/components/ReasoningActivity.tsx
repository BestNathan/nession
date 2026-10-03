/**
 * A row of the assistant's thinking, inside a turn's process window.
 *
 * ## Why it is a disclosure and not prose
 *
 * `conversation.md` puts reasoning under "Work sits below both": the answer is
 * the content and reasoning is the thing you *can* inspect. Drawing it as prose
 * would give a thought the same weight as the answer it produced, which is the
 * hierarchy inverted.
 *
 * It is a `<details>` for the same reason a group is — the reader opens it when
 * they want to know how the assistant got somewhere, and a transcript that
 * showed every thought by default would be mostly thinking.
 *
 * ## Provider first, and no paraphrase
 *
 * The summary is the provider's own words. This component lays it out and never
 * composes it: a transcript that rewrote someone's reasoning would be asserting
 * a thought nobody had, which is the same failure as fabricating a tool result.
 *
 * ## `running` is a real state
 *
 * A thought being produced now says so, with the same spinner a running tool
 * uses. Treating it as settled would draw a half-formed thought as a finished
 * one — and for a provider that streams reasoning, that is most of what the
 * reader would see.
 */

import { ChevronRight, Loader } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { chromeSansRole } from '@/shared/typography/chromeRoles'
import type { AIReasoningItem } from '../model/conversation'
import { ChatMarkdown } from '@/shared/markdown/ChatMarkdown'

export function ReasoningActivity({ item }: { item: AIReasoningItem }) {
  const running = item.status === 'running'

  return (
    <details
      data-testid="conversation-reasoning"
      data-status={item.status}
      className="group min-w-0"
    >
      <summary
        className={cn(
          'flex cursor-pointer items-center gap-2 py-1',
          'text-[var(--conversation-tool-foreground)]',
          chromeSansRole('metadata'),
        )}
      >
        <ChevronRight
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90"
        />
        <span className="truncate">
          {running ? 'Thinking' : 'Thought'}
        </span>
        {running ? (
          <span
            className="flex shrink-0 items-center"
            data-testid="conversation-reasoning-running"
          >
            <Loader aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            <span className="sr-only">still thinking</span>
          </span>
        ) : null}
      </summary>
      <div
        data-testid="conversation-reasoning-body"
        className={cn(
          'rounded-[var(--radius-surface)] bg-[var(--conversation-tool-surface)] px-3 py-2',
          'text-[var(--conversation-tool-foreground)]',
        )}
      >
        {/* The same Markdown path as every other body — a second one for a
            second kind of text is the thing #1363 refuses. */}
        <ChatMarkdown text={item.summary} streaming={running} />
      </div>
    </details>
  )
}
