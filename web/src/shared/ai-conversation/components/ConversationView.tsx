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
          {snapshot.state === 'ready' && snapshot.partialTail ? (
            <span data-testid="conversation-partial">· still being written</span>
          ) : null}
          {snapshot.state === 'ready' && snapshot.skipped > 0 ? (
            <span data-testid="conversation-skipped">· At least {snapshot.skipped} records not shown</span>
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

/**
 * The list's refresh failed while the rows it already had are still readable.
 *
 * Bounded and inline, above the rows rather than replacing them — the same
 * shape older paging uses, and for the same reason: the reader still has a list
 * to choose from, and taking it away because a refresh missed would punish them
 * for the network.
 */
function listRefreshMessage(snapshot: AIConversationSnapshot): string | null {
  if (snapshot.listError) {
    return snapshot.listError
  }
  if (snapshot.conversations.length > 0 && snapshot.listState === 'unavailable') {
    return 'Conversations cannot be refreshed right now'
  }
  return null
}

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
function ListStateGuard({
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
 * Whether the list has nothing to offer and the guard should speak instead.
 *
 * A failure or a load in progress with rows already on screen is *not* blocked:
 * the rows a reader can already see are worth more than a message about a
 * refresh that is still going.
 */
function listIsBlocked(snapshot: AIConversationSnapshot): boolean {
  // Nothing to choose from and nothing open: whatever the reason — still
  // loading, failed, unavailable, or answered-empty — the guard is the whole
  // story and an empty list would be a worse way to tell it.
  return snapshot.conversations.length === 0 && snapshot.openId === null
}

/** Neither one is open. */
function NothingOpen() {
  return (
    <p
      // Deliberately *not* `conversation-open`: that name belongs to the detail
      // pane, and a marker meaning "a conversation is open" that also appears
      // when none is would be worse than no marker at all.
      data-testid="conversation-nothing-open"
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
  onReload,
}: {
  snapshot: AIConversationSnapshot
  providerLabel: string
  layout: ConversationLayout
  onSelect: (id: string) => void
  onLoadOlder: () => boolean
  /** Ask the provider again after a failed read or listing. */
  onReload?: () => void
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
        onReload={onReload}
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
    // A grid rather than a flex row, and the columns are floors rather than
    // fixed widths: `18rem` is what the list takes when there is room, and
    // `14rem` is what the transcript will not go below. A list pinned at 18rem
    // on a 375px surface leaves the conversation about eighty pixels wide, in
    // which every word wraps to its own line — measured in the browser, not
    // guessed. The Web experience is the wide one by design (App pushes), but
    // "narrow" is not the same as "unusable".
    <div
      className="grid h-full min-h-0 grid-cols-[minmax(0,18rem)_minmax(14rem,1fr)]"
      data-testid="conversation-master-detail"
    >
      {/* `conversation-list` is the column, not the list component inside it —
          the name the e2e specs use to mean "the conversations a reader can
          choose from are on screen". It moved with the surface into the shared
          layer and had to keep meaning the same thing. */}
      <div className="min-h-0 overflow-auto border-r p-2" data-testid="conversation-list">
        {listIsBlocked(snapshot) ? (
          <ListStateGuard snapshot={snapshot} onReload={onReload} />
        ) : (
          <>
            {/* A refresh that failed *over rows that are still readable*.
                *
                * The guard above cannot report this one: it is answered only
                * when there is nothing to choose from, which is right for its
                * job and wrong for this state. So the rows that loaded stay —
                * they are what the reader was using — and the failure is
                * stated above them with the same one Retry the rest of the
                * surface uses.
                *
                * The alternative was to say nothing, and that is the defect
                * `#1363` round 4 names: `listError` was populated and drawn
                * nowhere, so a reader looking at a list that had just failed
                * to refresh could not tell it from one that had refreshed and
                * not moved. */}
            {listRefreshMessage(snapshot) ? (
              <ListRefreshError message={listRefreshMessage(snapshot) ?? ''} onReload={onReload} />
            ) : null}
            {list}
          </>
        )}
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        {snapshot.openId === null ? (
          <NothingOpen />
        ) : (
          // `conversation-open` marks the detail pane itself — the same meaning
          // it had before the surface moved to the shared framework.
          <div className="flex min-h-0 flex-1 flex-col" data-testid="conversation-open">
            <ConversationHeader snapshot={snapshot} />
            <ConversationTranscript
              snapshot={snapshot}
              providerLabel={providerLabel}
              onLoadOlder={onLoadOlder}
              onReload={onReload}
            />
          </div>
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
  onReload,
}: {
  snapshot: AIConversationSnapshot
  providerLabel: string
  onSelect: (id: string) => void
  onLoadOlder: () => boolean
  onReload?: () => void
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
        <div className="min-h-0 flex-1 overflow-auto p-2" data-testid="conversation-list">
          {listBlocked ? (
            <ListStateGuard snapshot={snapshot} onReload={onReload} />
          ) : (
            <>
              {listRefreshMessage(snapshot) ? (
                <ListRefreshError message={listRefreshMessage(snapshot) ?? ''} onReload={onReload} />
              ) : null}
              <ConversationList
                conversations={snapshot.conversations}
                openId={snapshot.openId}
                onSelect={choose}
              />
            </>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="conversation-open">
          <ConversationHeader snapshot={snapshot} onShowList={() => setShowingList(true)} />
          <ConversationTranscript
            snapshot={snapshot}
            providerLabel={providerLabel}
            onLoadOlder={onLoadOlder}
            onReload={onReload}
          />
        </div>
      )}
    </div>
  )
}
