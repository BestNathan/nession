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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { formatWorkDuration } from '@/shared/lib/format'
import { chromeSansRole } from '@/shared/typography/chromeRoles'
import type { AIConversationSnapshot } from '../runtime/ConversationRuntime'
import {
  carryGroupKeys,
  groupRows,
  rememberGroups,
  type ConversationRow,
} from '../model/grouping'
import { turnMembership, turnsOf, type ConversationTurn } from '../model/turns'
import { isStreaming } from './streaming'
import { TurnActions } from './TurnActions'
import { TurnProcess } from './TurnProcess'
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

/** Which item a row is anchored to — a group by its first call. */
function firstItemIdOf(row: ConversationRow): string {
  return row.kind === 'tools' ? (row.items[0]?.id ?? row.key) : row.item.id
}

/**
 * What a turn's copy action copies.
 *
 * The text blocks, joined the way the renderer draws them. A block the model
 * could not name contributes nothing rather than a placeholder: copying
 * `[unknown]` into someone's clipboard would be worse than copying less.
 */
function answerText(turn: ConversationTurn): string {
  if (turn.answer === null) {
    return ''
  }
  return turn.answer.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
}

/** The one line a folded turn shows in place of its work. */
function workLabel(turn: ConversationTurn): string {
  if (turn.durationMs === null) {
    return 'Worked'
  }
  return `Worked for ${formatWorkDuration(turn.durationMs)}`
}

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
  const [isAtTop, setIsAtTop] = useState(false)

  // Reading backwards is a *state the reader is in*, not a gesture they repeat.
  //
  // So the position is tracked as state, and the fetch is driven by a second
  // effect that watches it. That split is the whole behaviour: a page landing
  // changes `loadingOlder` and `items.length`, which re-runs the fetch effect,
  // and a reader who is still at the top gets the next page without having to
  // scroll again. Driven from inside the scroll handler instead — which is how
  // this was first written — nothing re-runs when a page lands, and paging back
  // through a long conversation becomes a series of nudges. Reported on
  // staging; the symptom is a reader having to jog the transcript to make it
  // continue.
  useEffect(() => {
    const content = contentRef.current
    const viewport = content?.closest('[data-slot="message-scroller-viewport"]')
    if (!(viewport instanceof HTMLElement)) {
      return
    }
    const sync = () => setIsAtTop(viewport.scrollTop <= TOP_THRESHOLD)
    // The *initial* position is deliberately not sampled. On mount the scroller
    // has not yet moved to the end, so reading it here says "at the top" and
    // the fetch effect immediately pulls a page of history nobody asked for —
    // measured in a browser, where opening a conversation rendered five turns
    // for a newest page of three. Sampling only on scroll means history starts
    // when the reader actually goes looking for it.
    viewport.addEventListener('scroll', sync, { passive: true })
    return () => viewport.removeEventListener('scroll', sync)
  }, [])

  useEffect(() => {
    if (!isAtTop) {
      return
    }
    if (!snapshot.hasMore || snapshot.loadingOlder) {
      return
    }
    if (snapshot.items.length === 0 || snapshot.state !== 'ready') {
      return
    }
    onLoadOlder()
  }, [
    isAtTop,
    snapshot.hasMore,
    snapshot.loadingOlder,
    snapshot.items.length,
    snapshot.state,
    onLoadOlder,
  ])

  const grouped = useMemo(() => groupRows(snapshot.items), [snapshot.items])
  // What each group was last rendered as. Kept here rather than in `groupRows`
  // because it is history, not a function of the items — see `carryGroupKeys`.
  const remembered = useRef(new Map<string, string>())
  const rows = useMemo(() => carryGroupKeys(grouped, remembered.current), [grouped])
  // Written after the render that used it, so a render that never commits
  // leaves nothing behind.
  useEffect(() => {
    rememberGroups(rows, remembered.current)
  }, [rows])

  const turns = useMemo(() => turnsOf(snapshot.items), [snapshot.items])
  const membership = useMemo(() => turnMembership(turns), [turns])
  // The turn being worked on: the last one, while the page says it is still
  // being appended to. Everything before it has finished, and a finished turn
  // folds — that is the "rest" state `conversation.md` describes.
  const workingKey = snapshot.partialTail ? (turns[turns.length - 1]?.key ?? null) : null
  const [overrides, setOverrides] = useState(() => new Map<string, boolean>())
  const isOpen = (turn: ConversationTurn) => overrides.get(turn.key) ?? turn.key === workingKey
  const toggle = (key: string) => {
    setOverrides((previous) => {
      const next = new Map(previous)
      next.set(key, !(previous.get(key) ?? key === workingKey))
      return next
    })
  }

  // One entry per row, with the turn it belongs to and — for the first row of a
  // turn's process — the control that opens it. A plan rather than stateful work
  // during render, because the rows are a flat list and "am I the first of my
  // turn" is a property of the list, not of the render that draws it.
  const plan = useMemo(() => {
    const emitted = new Set<string>()
    return rows.map((row) => {
      const entry = membership.get(firstItemIdOf(row))
      if (entry === undefined || !entry.process) {
        // Actions close a turn, so they hang off the row that answers it —
        // nothing else in the turn has anything to do.
        const answer = entry?.turn.answer ?? null
        const actions =
          answer !== null && firstItemIdOf(row) === answer.id ? entry?.turn ?? null : null
        return {
          row,
          turn: null as ConversationTurn | null,
          control: null as ConversationTurn | null,
          actions,
        }
      }
      const control = emitted.has(entry.turn.key) ? null : entry.turn
      emitted.add(entry.turn.key)
      return { row, turn: entry.turn, control, actions: null as ConversationTurn | null }
    })
  }, [rows, membership])

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
        plan={plan}
        isTurnOpen={isOpen}
        onToggleTurn={toggle}
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
  plan,
  isTurnOpen,
  onToggleTurn,
  onReload,
}: {
  snapshot: AIConversationSnapshot
  providerLabel: string
  lastId: string | undefined
  plan: readonly {
    row: ConversationRow
    turn: ConversationTurn | null
    control: ConversationTurn | null
    actions: ConversationTurn | null
  }[]
  isTurnOpen: (turn: ConversationTurn) => boolean
  onToggleTurn: (key: string) => void
  onReload?: () => void
}) {
  if (snapshot.threadError) {
    return <ConversationFailure message={snapshot.threadError} onRetry={onReload} />
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
  if (snapshot.threadLoading && snapshot.items.length === 0) {
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
      {plan.map(({ row, turn, control, actions }) => (
        <Fragment key={row.key}>
          {control === null ? null : (
            <MessageScrollerItem messageId={`${control.key}·process`}>
              <TurnProcess
                label={workLabel(control)}
                open={isTurnOpen(control)}
                onToggle={() => onToggleTurn(control.key)}
              />
            </MessageScrollerItem>
          )}
          {/* A folded turn's rows stay mounted and are hidden by attribute: the
              transcript is a flat list, and unmounting them would take their
              group identities, their scroll anchors and any focus inside them
              with it. */}
          <MessageScrollerItem
            messageId={row.key}
            hidden={turn !== null && !isTurnOpen(turn)}
          >
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
          {actions === null ? null : (
            <MessageScrollerItem messageId={`${actions.key}·actions`}>
              <TurnActions text={answerText(actions)} label="answer" />
            </MessageScrollerItem>
          )}
        </Fragment>
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
