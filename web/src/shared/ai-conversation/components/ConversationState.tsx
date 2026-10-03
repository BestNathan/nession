/**
 * Everything a transcript says when it is not saying messages.
 *
 * `#1363` SC-11 asks for these to mean the same thing across providers, and the
 * way that is achieved is by there being exactly one of each — a second
 * provider does not get to invent its own wording for "this conversation could
 * not be read".
 *
 * Two distinctions the states preserve, both measured in #1222 and both easy to
 * lose:
 *
 * - **Unavailable is not empty.** "This host does not have that directory" and
 *   "that directory has no conversations" are different sentences to a reader.
 * - **Not found is not an error.** A conversation that was deleted is not a
 *   failure to read one, and the selection stays on it rather than bouncing the
 *   reader back to the list with no explanation.
 */

import { AlertCircle, Loader } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/shared/lib/utils'
import { chromeSansRole } from '@/shared/typography/chromeRoles'

/** Older history is being fetched above what is already on screen. */
export function LoadingOlder() {
  return (
    <p
      data-testid="conversation-loading-older"
      role="status"
      className={cn(
        'flex items-center justify-center gap-2 pb-3 text-muted-foreground',
        chromeSansRole('metadata'),
      )}
    >
      <Loader aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
      Loading earlier messages…
    </p>
  )
}

/**
 * Older history failed while what is already loaded stays readable.
 *
 * Kept inline and above the transcript rather than replacing it: the reader
 * still has a conversation, and taking it away because one page failed would
 * punish them for the network.
 */
export function OlderError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      data-testid="conversation-older-error"
      role="alert"
      className={cn('flex flex-wrap items-center gap-2 pb-3 text-destructive', chromeSansRole('metadata'))}
    >
      <span>{message}</span>
      <Button variant="outline" size="xs" type="button" onClick={() => onRetry()}>
        Retry
      </Button>
    </div>
  )
}

/** A conversation that loaded and has nothing in it. */
export function EmptyConversation() {
  return (
    <p
      data-testid="conversation-empty"
      className={cn('flex items-center gap-2 text-muted-foreground', chromeSansRole('secondary'))}
    >
      <AlertCircle aria-hidden className="h-4 w-4" />
      This conversation has no messages yet.
    </p>
  )
}

/**
 * The provider could not read it, or could not say it has it.
 *
 * Carries a retry when the caller can offer one: a failure with no way to ask
 * again leaves the reader with nothing to do but leave and come back, which is
 * a worse answer than the failure itself.
 */
export function ConversationFailure({
  message,
  onRetry,
}: {
  message: string
  onRetry?: () => void
}) {
  return (
    <div
      data-testid="conversation-error"
      role="alert"
      className={cn('flex flex-wrap items-center gap-2 text-destructive', chromeSansRole('secondary'))}
    >
      <AlertCircle aria-hidden className="h-4 w-4 shrink-0" />
      <span>{message}</span>
      {onRetry ? (
        <Button variant="outline" size="xs" type="button" onClick={() => onRetry()}>
          Retry
        </Button>
      ) : null}
    </div>
  )
}

/**
 * The provider cannot say whether the conversation is there.
 *
 * The third of the three answers this file exists to keep apart. "That
 * directory has no conversations", "that conversation is gone" and "this host
 * cannot say right now" are three different sentences to a reader, and only the
 * first is about their conversation being empty — so rendering this one as
 * `EmptyConversation` makes a claim the provider explicitly did not make.
 *
 * It carries a retry for the same reason the failure state does, and for one
 * more: the runtime **stops refreshing** on a non-ready answer, so this is the
 * one degraded state the reader cannot wait their way out of. Without a way to
 * ask again it is a dead end that only a reload escapes.
 */
export function ConversationUnavailable({ onRetry }: { onRetry?: () => void }) {
  return (
    <div
      data-testid="conversation-unavailable"
      role="status"
      className={cn('flex flex-wrap items-center gap-2 text-muted-foreground', chromeSansRole('secondary'))}
    >
      <AlertCircle aria-hidden className="h-4 w-4 shrink-0" />
      <span>This conversation cannot be read right now.</span>
      {onRetry ? (
        <Button variant="outline" size="xs" type="button" onClick={() => onRetry()}>
          Retry
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Records the model does not name.
 *
 * Counted rather than listed, because the count is the actionable part: a
 * reader who sees "3 records were not shown" knows the transcript is complete
 * except for three things, where silence would let them believe it is complete.
 */
export function SkippedRecords({ count }: { count: number }) {
  if (count <= 0) {
    return null
  }
  return (
    <p
      // Distinct from the header's `conversation-skipped` count: the header
      // says it beside the title, and this says it at the end of the
      // transcript. Two markers with one name would make every assertion about
      // either of them ambiguous.
      data-testid="conversation-skipped-records"
      className={cn('flex items-center gap-2 text-muted-foreground', chromeSansRole('caption'))}
    >
      <AlertCircle aria-hidden className="h-3.5 w-3.5 shrink-0" />
      {count === 1 ? '1 record was not shown.' : `${count} records were not shown.`}
    </p>
  )
}
