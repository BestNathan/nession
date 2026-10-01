/**
 * A conversation surface: the list, the open conversation, or both.
 *
 * ## The two layouts are one composition
 *
 * `master-detail` is what a wide surface does — the list is already visible, so
 * a "back to the list" control would reveal something the reader can see.
 * `push` is what a narrow one does — one of the two is on screen, and the
 * control is the way between them. The difference is *composition*, not
 * content: both render the same [`ConversationList`] and the same
 * [`ConversationTranscript`], which is what `#1363` means by "surface 只决定
 * composition/density".
 *
 * There is deliberately no third variant per provider. A provider that wanted
 * its own layout would have to change this file, and that is the point.
 *
 * ## State guards come first
 *
 * The list's loading and error states are answered before anything else is
 * drawn, because "we could not list the conversations" and "this conversation
 * has no messages" are different sentences and a surface that conflated them
 * would show an empty pane for a failed request.
 */

import { AlertCircle, MessageSquare } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/components/ui/button'
import { chromeSansRole } from '@/shared/typography/chromeRoles'
import type { AIConversationSnapshot } from '../runtime/ConversationRuntime'
import { conversationLabel } from '../model/listing'
import { ConversationList } from './ConversationList'
import { ConversationTranscript } from './ConversationTranscript'

/** How the surface lays out, which is a width decision before it is anything else. */
export type ConversationLayout = 'master-detail' | 'push'

/**
 * The open conversation's identity and liveness.
 *
 * The label comes from the transcript's own `conversation`, which the read
 * response carries — so the header needs no join into the list by id, and the
 * two can never disagree (#1222).
 *
 * `activity` is the provider's own word and is shown as such: `inactive` is a
 * real, readable conversation that has finished, and saying so is the
 * difference between "not live" and "broken". `unknown` makes no claim at all
 * rather than guessing.
 */
function ConversationHeader({
  snapshot,
  onShowList,
}: {
  snapshot: AIConversationSnapshot
  /** Absent in master-detail, where the list is already on screen. */
  onShowList?: () => void
}) {
  const { conversation } = snapshot
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
      <div className="min-w-0">
        <p className={cn('truncate', chromeSansRole('primary'))} title={conversation?.id}>
          {conversationLabel(conversation)}
        </p>
        <p className={cn('flex items-center gap-2 text-muted-foreground', chromeSansRole('metadata'))}>
          {snapshot.activity === 'active' ? (
            <span data-testid="conversation-state">Running now</span>
          ) : snapshot.activity === 'inactive' ? (
            <span data-testid="conversation-state">Finished</span>
          ) : null}
          {snapshot.partialTail ? (
            <span data-testid="conversation-partial">· still being written</span>
          ) : null}
          {snapshot.skipped > 0 ? (
            <span data-testid="conversation-skipped">· {snapshot.skipped} records not shown</span>
          ) : null}
        </p>
      </div>
      {snapshot.conversations.length > 0 && onShowList ? (
        <Button
          variant="outline"
          size="sm"
          data-testid="conversation-show-list"
          onClick={() => onShowList()}
        >
          All conversations
        </Button>
      ) : null}
    </div>
  )
}

/** The list's own loading and failure states, answered before anything else. */
function ListStateGuard({ snapshot }: { snapshot: AIConversationSnapshot }) {
  if (snapshot.error && snapshot.conversations.length === 0) {
    return (
      <p
        data-testid="conversation-error"
        role="alert"
        className={cn('flex items-center gap-2 p-6 text-destructive', chromeSansRole('secondary'))}
      >
        <AlertCircle aria-hidden className="h-4 w-4 shrink-0" />
        {snapshot.error}
      </p>
    )
  }
  if (snapshot.loading && snapshot.conversations.length === 0) {
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
        data-testid="conversation-state"
        className={cn('p-6 text-muted-foreground', chromeSansRole('secondary'))}
      >
        This host has no conversations here.
      </p>
    )
  }
  return null
}

/**
 * Whether the list has nothing to offer and the guard should speak instead.
 *
 * A failure or a load in progress with rows already on screen is *not* blocked:
 * the rows a reader can already see are worth more than a message about a
 * refresh that is still going.
 */
function listIsBlocked(snapshot: AIConversationSnapshot): boolean {
  if (snapshot.conversations.length > 0) {
    return false
  }
  return (
    (snapshot.error !== null && snapshot.error !== undefined) ||
    snapshot.loading ||
    snapshot.listState === 'unavailable'
  )
}

/** Neither one is open. */
function NothingOpen() {
  return (
    <p
      data-testid="conversation-open"
      className={cn(
        'flex h-full items-center justify-center gap-2 p-6 text-muted-foreground',
        chromeSansRole('secondary'),
      )}
    >
      <MessageSquare aria-hidden className="h-4 w-4" />
      Choose a conversation.
    </p>
  )
}

export function ConversationView({
  snapshot,
  providerLabel,
  layout,
  onSelect,
  onLoadOlder,
}: {
  snapshot: AIConversationSnapshot
  providerLabel: string
  layout: ConversationLayout
  onSelect: (id: string) => void
  onLoadOlder: () => boolean
}) {
  // The guard replaces the list when it has something to say; otherwise the
  // list is the answer. The predicate lives here rather than beside the guard
  // because `react-refresh` requires a component file to export components.
  if (layout === 'push') {
    return (
      <PushLayout
        snapshot={snapshot}
        providerLabel={providerLabel}
        onSelect={onSelect}
        onLoadOlder={onLoadOlder}
      />
    )
  }

  const list = (
    <ConversationList
      conversations={snapshot.conversations}
      openId={snapshot.openId}
      onSelect={onSelect}
    />
  )

  return (
    <div className="flex h-full min-h-0" data-testid="conversation-master-detail">
      <div className="w-72 shrink-0 overflow-auto border-r p-2">
        {listIsBlocked(snapshot) ? <ListStateGuard snapshot={snapshot} /> : list}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {snapshot.openId === null ? (
          <NothingOpen />
        ) : (
          <>
            <ConversationHeader snapshot={snapshot} />
            <ConversationTranscript
              snapshot={snapshot}
              providerLabel={providerLabel}
              onLoadOlder={onLoadOlder}
            />
          </>
        )}
      </div>
    </div>
  )
}

/**
 * One pane at a time, which is what a narrow surface has room for.
 *
 * The "which pane" state is local and deliberately not the runtime's: it is
 * about what fits on screen, not about which conversation is open. Deriving it
 * from `openId` would make the list unreachable once something was selected —
 * there would be no way back that was not also a deselection.
 */
function PushLayout({
  snapshot,
  providerLabel,
  onSelect,
  onLoadOlder,
}: {
  snapshot: AIConversationSnapshot
  providerLabel: string
  onSelect: (id: string) => void
  onLoadOlder: () => boolean
}) {
  const [showingList, setShowingList] = useState(false)
  const listBlocked = listIsBlocked(snapshot)
  const showList = snapshot.openId === null || listBlocked || showingList

  // Choosing from the list closes it. Without this, a reader who opened the
  // list with "All conversations" would pick a conversation and stay on the
  // list, because the pane state and the selection are different facts.
  const choose = (id: string) => {
    setShowingList(false)
    onSelect(id)
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="conversation-push">
      {showList ? (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {listBlocked ? (
            <ListStateGuard snapshot={snapshot} />
          ) : (
            <ConversationList
              conversations={snapshot.conversations}
              openId={snapshot.openId}
              onSelect={choose}
            />
          )}
        </div>
      ) : (
        <>
          <ConversationHeader snapshot={snapshot} onShowList={() => setShowingList(true)} />
          <ConversationTranscript
            snapshot={snapshot}
            providerLabel={providerLabel}
            onLoadOlder={onLoadOlder}
          />
        </>
      )}
    </div>
  )
}
