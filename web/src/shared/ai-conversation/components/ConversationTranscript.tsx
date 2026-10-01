/**
 * The transcript: a runtime snapshot in, a conversation out.
 *
 * This is the component every surface shares. Peek and Workspace differ by the
 * space they give it and how deep they let it go — not by having their own
 * copy, which is what `#1363` forbids by name ("不允许变成 Claude Peek
 * renderer / Claude Workspace renderer / Codex Peek renderer…").
 *
 * ## Scroll is the scroller's, not ours
 *
 * `MessageScroller` (#1267) owns initial position, tail-follow, prepend-anchor
 * preservation and the jump-to-bottom control. This component only *asks* for
 * older history when the reader reaches the top — and it asks synchronously,
 * because the scroll controller decides from that answer whether to keep its
 * pending anchor. Reading `loadingOlder` later, even one microtask later, races
 * React's deferred flush of wheel-event renders and disarms a fetch that is
 * genuinely on its way. That is why `onLoadOlder` returns a boolean rather than
 * a promise.
 */

import { useCallback, useEffect, useRef } from 'react'
import { AlertCircle } from 'lucide-react'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller'
import { cn } from '@/shared/lib/utils'
import { chromeSansRole } from '@/shared/typography/chromeRoles'
import type { AIConversationSnapshot } from '../runtime/ConversationRuntime'
import { groupRows } from '../model/grouping'
import { isStreaming } from './streaming'
import { ConversationMessage } from './ConversationMessage'
import { ToolActivity, UnknownActivity } from './ToolActivity'
import { ToolGroup } from './ToolGroup'
import {
  ConversationFailure,
  EmptyConversation,
  LoadingOlder,
  OlderError,
  SkippedRecords,
} from './ConversationState'

/** How close to the top counts as "at the top", in px. */
const TOP_THRESHOLD = 50

function TranscriptContent({
  snapshot,
  providerLabel,
  onLoadOlder,
  onReload,
}: {
  snapshot: AIConversationSnapshot
  providerLabel: string
  onLoadOlder: () => boolean
  /** Ask again after a read failed. */
  onReload?: () => void
}) {
  const contentRef = useRef<HTMLDivElement>(null)

  // Older history is fetched when the reader reaches the top, not when the
  // transcript merely becomes short — a conversation with four messages should
  // not spend the reader's bandwidth proving it has no more.
  useEffect(() => {
    const content = contentRef.current
    const viewport = content?.closest('[data-slot="message-scroller-viewport"]')
    if (!(viewport instanceof HTMLElement)) {
      return
    }
    const onScroll = () => {
      if (viewport.scrollTop > TOP_THRESHOLD) {
        return
      }
      if (!snapshot.hasMore || snapshot.loadingOlder || snapshot.items.length === 0) {
        return
      }
      if (snapshot.state !== 'ready') {
        return
      }
      onLoadOlder()
    }
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', onScroll)
  }, [snapshot.hasMore, snapshot.loadingOlder, snapshot.items.length, snapshot.state, onLoadOlder])

  const rows = groupRows(snapshot.items)
  const lastIndex = snapshot.items.length - 1
  const lastId = lastIndex >= 0 ? snapshot.items[lastIndex]?.id : undefined

  return (
    <MessageScrollerContent ref={contentRef} className="px-4">
      {snapshot.loadingOlder ? <LoadingOlder /> : null}
      {snapshot.olderError ? (
        <OlderError message={snapshot.olderError} onRetry={onLoadOlder} />
      ) : null}
      <ConversationBody
        snapshot={snapshot}
        providerLabel={providerLabel}
        lastId={lastId}
        rows={rows}
        onReload={onReload}
      />
    </MessageScrollerContent>
  )
}

/**
 * What to draw between the paging rows and the end.
 *
 * Split out so the transcript's own component stays a composition rather than
 * a six-branch render: which of these applies is a property of the snapshot,
 * and reading them in one place is how "unavailable is not empty" stays true
 * after the next edit.
 */
function ConversationBody({
  snapshot,
  providerLabel,
  lastId,
  rows,
  onReload,
}: {
  snapshot: AIConversationSnapshot
  providerLabel: string
  lastId: string | undefined
  rows: ReturnType<typeof groupRows>
  onReload?: () => void
}) {
  if (snapshot.error) {
    return <ConversationFailure message={snapshot.error} onRetry={onReload} />
  }
  if (snapshot.state === 'not_found') {
    return (
      <p
        data-testid="conversation-missing"
        className={cn('flex items-center gap-2 text-muted-foreground', chromeSansRole('secondary'))}
      >
        <AlertCircle aria-hidden className="h-4 w-4" />
        This conversation is no longer available.
      </p>
    )
  }
  if (snapshot.loading && snapshot.items.length === 0) {
    return (
      <p
        data-testid="conversation-loading"
        role="status"
        className={cn('text-muted-foreground', chromeSansRole('secondary'))}
      >
        Loading conversation…
      </p>
    )
  }
  if (snapshot.items.length === 0) {
    return <EmptyConversation />
  }
  return (
    <>
      {rows.map((row) => (
        <MessageScrollerItem key={row.key} messageId={row.key}>
          {row.kind === 'tools' ? (
            <ToolGroup items={row.items} summary={row.summary} />
          ) : row.item.kind === 'tool' ? (
            <ToolActivity item={row.item} />
          ) : row.item.kind === 'message' ? (
            <ConversationMessage
              item={row.item}
              label={providerLabel}
              streaming={isStreaming(row.item, row.item.id === lastId, snapshot.partialTail)}
            />
          ) : (
            <UnknownActivity />
          )}
        </MessageScrollerItem>
      ))}
      <SkippedRecords count={snapshot.skipped} />
    </>
  )
}

/**
 * The transcript, oldest first, following the tail.
 *
 * A surface gives it a snapshot and the two commands it needs; everything else
 * — grouping, disclosure, the paging trigger, the empty and failure states —
 * is here, so a surface cannot get one of them subtly wrong.
 */
export function ConversationTranscript({
  snapshot,
  providerLabel,
  onLoadOlder,
  onReload,
}: {
  snapshot: AIConversationSnapshot
  /** The provider's name for the assistant, from its adapter's identity. */
  providerLabel: string
  /** Starts an older-page fetch; answers synchronously whether one engaged. */
  onLoadOlder: () => boolean
  /** Ask the provider again after a failed read. */
  onReload?: () => void
}) {
  const loadOlder = useCallback(() => onLoadOlder(), [onLoadOlder])
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller>
        <MessageScrollerViewport preserveScrollOnPrepend>
          <TranscriptContent
            snapshot={snapshot}
            providerLabel={providerLabel}
            onLoadOlder={loadOlder}
            onReload={onReload}
          />
        </MessageScrollerViewport>
        <MessageScrollerButton direction="end" />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
