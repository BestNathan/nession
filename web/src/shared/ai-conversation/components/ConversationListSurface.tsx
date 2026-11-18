/**
 * The conversation directory, with its own loading and failure answers.
 *
 * Web and App both draw "the conversations a reader may choose from", and both
 * owe the reader the same four distinctions: still loading, failed, this host
 * cannot list them, and this directory has none. Written per surface, one of
 * those quietly becomes the other — the defect #1363 SC-11 recorded when a list
 * refresh failure replaced a readable thread. One owner, reached by both.
 *
 * The caller owns the pane: which surface wraps this (a bordered column, a
 * padded list, a pushed depth) is composition, not the directory's answer.
 */

import { AlertCircle } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/components/ui/button'
import { chromeSansRole } from '@/shared/typography/chromeRoles'
import type { AIConversationSnapshot } from '../runtime/ConversationRuntime'
import { ConversationList } from './ConversationList'
import { listIsBlocked, listRefreshMessage } from './conversationListState'

function ListRefreshError({ message, onReload }: { message: string; onReload?: () => void }) {
  return (
    <div
      data-testid="conversation-list-error"
      role="alert"
      className={cn(
        'mb-2 flex flex-wrap items-center gap-2 rounded-[var(--nession-radius-surface)] p-2 text-destructive',
        chromeSansRole('metadata'),
      )}
    >
      <AlertCircle aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">{message}</span>
      {onReload ? (
        <Button variant="outline" size="xs" type="button" onClick={() => onReload()}>
          Retry
        </Button>
      ) : null}
    </div>
  )
}

/** The list's own loading and failure states, answered before anything else. */
export function ConversationListStateGuard({
  snapshot,
  onReload,
}: {
  snapshot: AIConversationSnapshot
  onReload?: () => void
}) {
  if (snapshot.listError && snapshot.conversations.length === 0) {
    return (
      <div
        data-testid="conversation-error"
        role="alert"
        className={cn(
          'flex flex-wrap items-center gap-2 p-6 text-destructive',
          chromeSansRole('secondary'),
        )}
      >
        <AlertCircle aria-hidden className="h-4 w-4 shrink-0" />
        <span>{snapshot.listError}</span>
        {onReload ? (
          <Button variant="outline" size="xs" type="button" onClick={() => onReload()}>
            Retry
          </Button>
        ) : null}
      </div>
    )
  }
  if (snapshot.listLoading && snapshot.conversations.length === 0) {
    return (
      <p
        data-testid="conversation-loading"
        role="status"
        className={cn('p-6 text-muted-foreground', chromeSansRole('secondary'))}
      >
        Loading conversations…
      </p>
    )
  }
  if (snapshot.listState === 'unavailable') {
    return (
      <p
        data-testid="conversation-unavailable"
        className={cn('p-6 text-muted-foreground', chromeSansRole('secondary'))}
      >
        This host has no conversations here.
      </p>
    )
  }
  if (snapshot.listState === 'ready') {
    // Distinct from `unavailable` and from a failed read: the provider answered
    // and the answer is that there is nothing here. Saying "unavailable" for
    // this would tell the reader to check something that is working.
    return (
      <p
        data-testid="conversation-not-found"
        className={cn('p-6 text-muted-foreground', chromeSansRole('secondary'))}
      >
        No conversations here yet.
      </p>
    )
  }
  return null
}

/**
 * The directory itself.
 *
 * `touch` is the App's 44px row floor; Web omits it and keeps its tighter row.
 */
export function ConversationListSurface({
  snapshot,
  onSelect,
  onReload,
  touch = false,
}: {
  snapshot: AIConversationSnapshot
  onSelect: (id: string) => void
  onReload?: () => void
  touch?: boolean
}) {
  if (listIsBlocked(snapshot)) {
    return <ConversationListStateGuard snapshot={snapshot} onReload={onReload} />
  }
  const refreshMessage = listRefreshMessage(snapshot)
  return (
    <>
      {refreshMessage ? (
        <ListRefreshError message={refreshMessage} onReload={onReload} />
      ) : null}
      <ConversationList
        conversations={snapshot.conversations}
        openId={snapshot.openId}
        onSelect={onSelect}
        touch={touch}
      />
    </>
  )
}
