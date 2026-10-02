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

import type { AIMessageItem, AIConversationItem } from './conversation'

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

function timeOf(item: AIConversationItem): number | null {
  const timestamp = messageOf(item)?.timestamp
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
 */
function durationOf(items: AIConversationItem[]): number | null {
  const times = items.map(timeOf).filter((time): time is number => time !== null)
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

  // The answer is the *last* assistant message. Everything before it is
  // progress towards it; anything after it — a trailing notice, a status row —
  // is not the answer either, and stays in the process window so the renderer
  // can keep it out of the fold (`conversation.md`: notices never fold).
  let answer: AIMessageItem | null = null
  for (const item of items) {
    const message = messageOf(item)
    if (message !== null && message.role === 'assistant') {
      answer = message
    }
  }

  const process = items.filter(
    (item, index) => item !== answer && !(opening !== null && index === 0),
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
