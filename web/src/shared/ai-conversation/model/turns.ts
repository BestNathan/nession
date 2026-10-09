/**
 * Cutting a transcript into turns.
 *
 * ## A turn is a location, not a container
 *
 * `conversation.md` states it and this module obeys it: the transcript stays a
 * flat ordered list, and "which turn" and "which step of it" are properties
 * carried by each item. Nothing here nests. That is what lets a turn's process
 * fold without re-parenting the rows inside it — and re-parenting is what would
 * remount them, which is the class of bug [#1386] fixed for a single group.
 *
 * So this module answers a question rather than building a tree: *given the
 * items, what does each turn consist of?* The renderer keeps drawing a flat list
 * and asks this which rows belong to a turn and which of them are its work.
 *
 * ## The four parts
 *
 * ```text
 * opening   the user's message — what the turn is
 * process   the work: tool rows, and any assistant progress before the answer
 * answer    the last assistant message — what the turn is *for*
 * actions   not here: they belong to a surface, not to the transcript's model
 * ```
 *
 * An assistant message is the answer only if it is the *last* one. Everything
 * the assistant said before it was progress towards it, and progress belongs
 * inside the process window — that is what "intermediate assistant progress"
 * means, and treating each assistant message as an answer would put three
 * answers in a turn that has one.
 *
 * ## A turn may not open
 *
 * A transcript read backwards from the middle of a conversation starts mid-turn:
 * there is no user message above the oldest item. That is not a turn without an
 * opening to invent — `opening` is `null` and the turn is keyed by whatever it
 * does start with. Same for a transcript whose provider never emits user
 * messages at all, which is a legitimate thing for a provider to do.
 */

import type {
  AIMessageItem,
  AIReasoningItem,
  AIConversationItem,
  AIToolItem,
} from './conversation'

export interface ConversationTurn {
  /**
   * Stable for as long as the turn is: the opening message's id, or the first
   * item's when the turn does not open with one.
   *
   * Not derived from the turn's length or its answer — a turn grows at its end
   * while the assistant works, and its identity must not move as it does.
   */
  key: string
  /** The user's message, when the turn has one. */
  opening: AIMessageItem | null
  /** The work, oldest first. Empty when the assistant answered without any. */
  process: AIConversationItem[]
  /** The assistant's last message, when it has answered. */
  answer: AIMessageItem | null
  /**
   * How long the turn took, when both ends stated a time.
   *
   * `null` rather than a guess: a provider that does not timestamp its items
   * cannot be given a duration, and inventing one from arrival times would
   * report the reader's connection rather than the assistant's work.
   */
  durationMs: number | null
}

function messageOf(item: AIConversationItem): AIMessageItem | null {
  return item.kind === 'message' ? item : null
}

function isUser(item: AIConversationItem): boolean {
  return messageOf(item)?.role === 'user'
}

/**
 * Whether an item is the assistant *working*, as opposed to something it said.
 *
 * `unknown` is deliberately not work: an unmodelled record is not evidence that
 * anything is still happening, and treating it as such would end the turn for
 * any provider that trails one.
 */
function isWork(item: AIConversationItem): item is AIToolItem | AIReasoningItem {
  return item.kind === 'tool' || item.kind === 'reasoning'
}

function timeOf(item: AIConversationItem): number | null {
  // Straight off the item, not through `messageOf`. Every arm of the union
  // carries `timestamp` — that is what makes the rule `durationOf` states
  // implementable — and reading it through the message narrowing is what
  // silently turned "any timestamped item" into "the messages". A provider that
  // timestamps its work and not its participants was being told `Worked` while
  // its own data supported `Worked for …`.
  const timestamp = item.timestamp
  if (timestamp === undefined || timestamp === null) {
    return null
  }
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * The span the turn's own timestamps state.
 *
 * Taken from any timestamped item in the turn, not from the answer alone: a turn
 * whose answer has no timestamp but whose tools do still has a measurable
 * duration, and requiring the answer's would silently drop it.
 *
 * Not from *every* item, though, and the difference is the label's verb. A
 * status notice is not the assistant's work — that is why it does not fold —
 * so a provider that reports "connection closed" ten minutes after the answer
 * must not turn `Worked for 1m` into `Worked for 11m`. An unmodelled record is
 * not work either, for the reason `isWork` gives. The duration domain is the
 * turn's participants and its work, which is the same line the fold draws.
 */
function durationOf(items: AIConversationItem[]): number | null {
  const times = items
    .filter((item) => item.kind !== 'status' && item.kind !== 'unknown')
    .map(timeOf)
    .filter((time): time is number => time !== null)
  if (times.length < 2) {
    return null
  }
  return Math.max(...times) - Math.min(...times)
}

function turnOf(items: AIConversationItem[]): ConversationTurn {
  const [first] = items
  if (first === undefined) {
    throw new Error('a turn is built from at least one item')
  }
  const firstMessage = messageOf(first)
  const opening = firstMessage !== null && firstMessage.role === 'user' ? firstMessage : null

  // The answer is the last assistant message **that no work follows**.
  //
  // "The last assistant message" alone was the rule, and it is wrong in the case
  // a live turn produces constantly: the assistant says something and then goes
  // back to work. That message is progress towards an answer nobody has written
  // yet, and calling it the answer *ends the turn* — the fold closes, the copy
  // action appears, and work that is still happening is drawn as finished.
  // `#1363` round 3.
  //
  // A message the assistant is still streaming is never the answer either, but
  // that is the renderer's `workingOf` to decide; here it is only about order.
  let answer: AIMessageItem | null = null
  for (const item of items) {
    const message = messageOf(item)
    if (message !== null && message.role === 'assistant') {
      answer = message
    } else if (answer !== null && isWork(item)) {
      answer = null
    }
  }

  // A status notice is not the assistant's work, so it is not inside the window
  // a fold closes over — see `AIStatusItem` for why that reading won over the
  // other one the canonical document offers. Leaving it out of `process` is the
  // whole mechanism: the renderer folds by turn membership, so an item with
  // none is never hidden.
  //
  // An unmodelled record is the same case, and this used to contradict itself
  // about it: `isWork` says `unknown` is not work, while `process` — built by
  // exclusion — put it in the window anyway (`#1363` round 4). The canonical
  // anatomy settles it, and not by preference: its process window is "tool
  // activity rows, reasoning rows", and the rule that follows names what must
  // not fold — "rows that are **not** the assistant's work". A record we
  // cannot model is not evidence of work any more than it is evidence of
  // anything, so folding it under a control reading "Worked" would be the
  // classification the model exists to refuse. It keeps its place in the
  // transcript and is drawn as what it is: unmodelled.
  const process = items.filter(
    (item, index) =>
      item !== answer &&
      item.kind !== 'status' &&
      item.kind !== 'unknown' &&
      !(opening !== null && index === 0),
  )

  return {
    key: first.id,
    opening,
    process,
    answer,
    durationMs: durationOf(items),
  }
}

/**
 * The transcript as turns, oldest first.
 *
 * A turn opens at a user message and runs until the next one. Items above the
 * first user message are their own turn — a transcript that starts mid-turn is
 * a transcript, not an error.
 */
export function turnsOf(items: AIConversationItem[]): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  let run: AIConversationItem[] = []

  const flush = () => {
    if (run.length > 0) {
      turns.push(turnOf(run))
    }
    run = []
  }

  for (const item of items) {
    // A user message *opens* a turn, so it closes whatever came before — except
    // when it is the first thing in the run, which is the normal case.
    if (isUser(item) && run.length > 0) {
      flush()
    }
    run.push(item)
  }
  flush()

  return turns
}

/**
 * Whether the turn's work is still running.
 *
 * The other half of the same finding, and the one that survives a final answer:
 * a turn can have an answer *and* a work item that has not finished — the
 * assistant replied, and a tool it started is still going. Such a turn is not
 * settled, and treating it as settled folds away the only thing still moving.
 *
 * Read from the canonical items rather than from what the provider said about
 * the answer, because a provider that reports a tool's `running` state has
 * already told us everything this needs, and one that does not simply never
 * reports it. Nothing here is provider-specific.
 */
export function runningWork(turn: ConversationTurn): boolean {
  return turn.process.some((item) => isWork(item) && item.status === 'running')
}

/**
 * Whether the turn has not settled yet.
 *
 * The canonical phase, and the only place it is decided. The renderer needs it
 * twice — the process is open while a turn is working, and the turn's actions
 * are not available until it is not — and those two used to derive their
 * answers separately, which is how the same frame could show an open process
 * *and* a Copy button on an answer that was still being written (`#1363`
 * round 4).
 *
 * Three signals, none of them provider-specific: an answer that has not been
 * written, an answer the provider says is still streaming, and work it says is
 * still running. A provider that reports none of them simply never reaches the
 * streaming arm, which is the same shape as `runningWork`.
 *
 * The page's own `partialTail` is deliberately *not* here. It is a property of
 * the read rather than of the turn, so it belongs to whoever holds the page —
 * the renderer composes the two rather than the model learning about reads.
 */
export function isWorking(turn: ConversationTurn): boolean {
  return turn.answer === null || turn.answer.status === 'streaming' || runningWork(turn)
}

export interface TurnMembership {
  turn: ConversationTurn
  /** Whether the item is inside the turn's process window. */
  process: boolean
}

/**
 * Which turn each item belongs to, and whether it is that turn's work.
 *
 * The renderer draws a flat list, so this is how a row finds out what it is part
 * of without anything being re-parented — which is the whole reason a turn is a
 * location rather than a container. A caller holding an item's id does not have
 * to walk the turns again to place it.
 */
export function turnMembership(turns: ConversationTurn[]): Map<string, TurnMembership> {
  const membership = new Map<string, TurnMembership>()
  for (const turn of turns) {
    if (turn.opening !== null) {
      membership.set(turn.opening.id, { turn, process: false })
    }
    for (const item of turn.process) {
      membership.set(item.id, { turn, process: true })
    }
    if (turn.answer !== null) {
      membership.set(turn.answer.id, { turn, process: false })
    }
  }
  return membership
}

/**
 * Every item a turn is made of, in transcript order.
 *
 * All three parts rather than `process` alone: identity is carried from whatever
 * the renderer has already seen, and the opening and the answer are exactly the
 * items most likely to be that one.
 */
function itemsOfTurn(turn: ConversationTurn): AIConversationItem[] {
  const items: AIConversationItem[] = []
  if (turn.opening !== null) {
    items.push(turn.opening)
  }
  items.push(...turn.process)
  if (turn.answer !== null) {
    items.push(turn.answer)
  }
  return items
}

/**
 * Keep a turn's key still across a prepend that reveals its opening.
 *
 * `turnOf` derives the key from the turn's first item, and for a window that has
 * always started where it starts that is the right answer. It stops being one the
 * moment an older page arrives, because a transcript read backwards *begins*
 * mid-turn: the first item is some tool call, and when `load older` finally
 * delivers the user message that opened it, the derived key moves from that tool
 * call to the opener.
 *
 * Everything that remembers a turn is keyed by that string — above all the
 * disclosure override that decides whether the work is folded. So the key moving
 * silently drops the reader's expansion and collapses the work under them, which
 * is [#1386]'s defect one level up: that fix protected the `ToolGroup` *inside*
 * the process window and left the window itself unprotected.
 *
 * The identity is history, exactly as a group's is and for the same reason — it
 * cannot be derived from the items in front of it, because those items are
 * precisely what changed. So it is carried by the ids the renderer has already
 * seen, first one wins, which preserves the key the disclosure was recorded
 * under.
 *
 * Reading only — [`rememberTurns`] is the write, and it belongs in an effect
 * rather than in render, so a render that never commits cannot leave a trace.
 */
export function carryTurnKeys(
  turns: readonly ConversationTurn[],
  remembered: ReadonlyMap<string, string>,
): ConversationTurn[] {
  return turns.map((turn) => {
    let carried: string | null = null
    for (const item of itemsOfTurn(turn)) {
      const held = remembered.get(item.id)
      if (held !== undefined) {
        carried = held
        break
      }
    }
    return carried === null || carried === turn.key ? turn : { ...turn, key: carried }
  })
}

/**
 * Remember which key each turn's items were rendered under.
 *
 * Ids that are in no turn any more are forgotten, so the map holds exactly what
 * is on screen instead of growing with the conversation. A stale id could not be
 * adopted anyway — an item belongs to one turn — so forgetting costs nothing.
 */
export function rememberTurns(
  turns: readonly ConversationTurn[],
  remembered: Map<string, string>,
): void {
  const live = new Set<string>()
  for (const turn of turns) {
    for (const item of itemsOfTurn(turn)) {
      remembered.set(item.id, turn.key)
      live.add(item.id)
    }
  }
  for (const id of [...remembered.keys()]) {
    if (!live.has(id)) {
      remembered.delete(id)
    }
  }
}
