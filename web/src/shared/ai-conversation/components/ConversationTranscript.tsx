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
import {
  carryTurnKeys,
  rememberTurns,
  runningWork,
  turnMembership,
  turnsOf,
  type ConversationTurn,
} from '../model/turns'
import { useFocusPinsTurn } from '../runtime/useFocusPinsTurn'
import { useReaderIntent } from '../runtime/useReaderIntent'
import { isStreaming } from './streaming'
import { TurnActions } from './TurnActions'
import { TurnProcess } from './TurnProcess'
import { ConversationMessage } from './ConversationMessage'
import { ReasoningActivity } from './ReasoningActivity'
import { StatusNotice } from './StatusNotice'
import { ToolActivity, UnknownActivity } from './ToolActivity'
import { ToolGroup } from './ToolGroup'
import {
  ConversationFailure,
  ConversationUnavailable,
  EmptyConversation,
  LoadingOlder,
  OlderError,
  SkippedRecords,
} from './ConversationState'

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
  const wantsOlder = useReaderIntent(contentRef, snapshot.openId)

  useEffect(() => {
    if (!wantsOlder) {
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
    wantsOlder,
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

  const derivedTurns = useMemo(() => turnsOf(snapshot.items), [snapshot.items])
  // A second map, not the group one above: an item belongs to a group *and* to a
  // turn, and one map would let either answer for the other. Keyed by id like
  // the group map, and carried for the same reason — see `carryTurnKeys`.
  const rememberedTurns = useRef(new Map<string, string>())
  const turns = useMemo(() => carryTurnKeys(derivedTurns, rememberedTurns.current), [derivedTurns])
  useEffect(() => {
    rememberTurns(turns, rememberedTurns.current)
  }, [turns])

  const membership = useMemo(() => turnMembership(turns), [turns])
  const lastKey = turns[turns.length - 1]?.key ?? null

  /**
   * Whether a turn is still being worked on — the pattern's two live phases.
   *
   * **Working only.** The turn has no answer, so its work is the only thing it
   * has to show. Folding it renders the turn as a question and then silence,
   * which is what the first version of this did; a question whose work has been
   * hidden and whose answer has not been written is not the "rest" state, it is
   * a hole.
   *
   * **Streaming output.** The answer is on its way and the reader is watching it
   * arrive. It stays open for that reason even though it now *has* an answer.
   *
   * Two signals say whether output is streaming, and they are the two
   * `isStreaming` already weighs: what the provider stated about the message,
   * and what the page said about itself. A provider that states a status is
   * believed; the page's mid-record flag is the fallback, and it only speaks for
   * the turn the page ended in.
   */
  const workingOf = (turn: ConversationTurn): boolean =>
    turn.answer === null ||
    turn.answer.status === 'streaming' ||
    // Work still running outranks an answer. A tool the assistant started and
    // has not finished means the turn is not settled, whatever it said before
    // starting it — folding here would close the only thing still moving.
    runningWork(turn) ||
    (turn.key === lastKey && snapshot.partialTail)

  const [overrides, setOverrides] = useState(() => new Map<string, boolean>())
  const isOpen = (turn: ConversationTurn) => overrides.get(turn.key) ?? workingOf(turn)
  // Focusing inside a turn's work records that it stays open, so the automatic
  // settle cannot close what the reader is inspecting. See `useFocusPinsTurn`
  // for why this is an override rather than a condition on `isOpen`.
  useFocusPinsTurn(contentRef, (key) => {
    setOverrides((previous) => {
      if (previous.get(key) === true) {
        return previous
      }
      const next = new Map(previous)
      next.set(key, true)
      return next
    })
  })
  const toggle = (key: string) => {
    setOverrides((previous) => {
      const next = new Map(previous)
      const turn = turns.find((candidate) => candidate.key === key)
      next.set(key, !(previous.get(key) ?? (turn !== undefined && workingOf(turn))))
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
  // Before the empty check, deliberately. `unavailable` is a state the provider
  // answered with, not the absence of an answer, and it reaches here with
  // `items` either empty (a first read that could not be made) or *full* (a
  // readable thread whose re-read came back unavailable). Both must render as
  // this state: the first would otherwise be told it has no messages, and the
  // second would keep showing a transcript as if it were current, which is the
  // worse of the two — stale content is indistinguishable from live content.
  if (snapshot.state === 'unavailable') {
    return <ConversationUnavailable onRetry={onReload} />
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
            // Which turn this row draws. The focus rule reads it to know what to
            // keep open, and it is only set on the rows a fold can hide.
            data-turn-key={turn?.key}
            hidden={turn !== null && !isTurnOpen(turn)}
          >
            {row.kind === 'tools' ? (
              <ToolGroup items={row.items} summary={row.summary} />
            ) : row.item.kind === 'tool' ? (
              <ToolActivity item={row.item} />
            ) : row.item.kind === 'reasoning' ? (
              <ReasoningActivity item={row.item} />
            ) : row.item.kind === 'status' ? (
              <StatusNotice item={row.item} />
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
            // Scoped to the conversation, not merely to this component. Every
            // piece of state below — the disclosure overrides, both identity
            // maps, the focus pin — is keyed by item, turn and group ids, and
            // those are unique only *within* a conversation. Without this, two
            // threads that reuse an id inherit each other's expansion and
            // focus. `#1363` round 3.
            //
            // A `key` rather than a reset-on-change effect, because an effect
            // runs *after* the render that already drew the new conversation
            // with the old state; with `key` the state never exists in a render
            // it does not belong to.
            //
            // Prepends and refreshes do not change `openId`, which is exactly
            // the distinction the review drew: preserving state across a prepend
            // and dropping it across a switch are requirements pulling opposite
            // ways, so the boundary has to be the conversation and nothing
            // coarser.
            key={snapshot.openId ?? 'no-conversation'}
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
