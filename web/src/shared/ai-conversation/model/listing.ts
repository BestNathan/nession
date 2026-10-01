/**
 * How a list of conversations is grouped, labelled and previewed.
 *
 * Ported from the Claude Code capability, where it was measured, into the
 * shared layer where a second provider can use it — the alternative is every
 * provider inventing its own bucketing and disagreeing about what "Today"
 * means, which is exactly the "同一种 AI 对话变成多套体验" `#1363` is about.
 *
 * These operate on [`AIConversationSummary`], not on any provider's item, so
 * nothing here knows what a `cwd` is.
 */

import type { AIConversationSummary } from './conversation'

export type DateBucket = 'today' | 'previous-7-days' | 'older'

export const BUCKET_ORDER: DateBucket[] = ['today', 'previous-7-days', 'older']

export const BUCKET_LABELS: Record<DateBucket, string> = {
  today: 'Today',
  'previous-7-days': 'Previous 7 days',
  older: 'Older',
}

/** Milliseconds in a day, as the calendar arithmetic below uses it. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Midnight at the start of `at`'s local day.
 *
 * Built from the local Y/M/D rather than by subtracting a time-of-day offset,
 * because `setHours(0,0,0,0)` is the one form that stays correct across a DST
 * transition — subtracting `getHours()` hours would land an hour off on the two
 * days a year the offset changes.
 */
function startOfDay(at: Date): number {
  const midnight = new Date(at)
  midnight.setHours(0, 0, 0, 0)
  return midnight.getTime()
}

/**
 * The bucket `timestamp` falls in, or `null` when there is no usable date.
 *
 * ## Why `now` is a parameter
 *
 * A relative label is the one thing here that changes without anything
 * changing. Defaulting to `new Date()` would make the function untestable at
 * exactly the boundaries that matter — midnight, and the seventh day back —
 * and those are where a bug would live, so the tests can stand *on* a boundary
 * rather than beside it.
 *
 * ## Calendar days, not 24-hour windows
 *
 * "Today" has to mean the day the reader is in: at 09:00, something from 20:00
 * yesterday is *yesterday* to a person and would be "today" to a rolling
 * window. So the boundaries are local midnights, and "Previous 7 days" is the
 * seven days before the current one.
 *
 * ## `null` is an answer
 *
 * A conversation with no timestamp, or an unparseable one, gets **no bucket**
 * rather than being filed under `older`. The provider sorts those last on
 * purpose — no timestamp is not evidence of age — and filing them under
 * `older` would assert a fact nothing knows.
 */
export function bucketOf(
  timestamp: string | null | undefined,
  now: Date = new Date(),
): DateBucket | null {
  if (!timestamp) {
    return null
  }
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) {
    return null
  }

  const today = startOfDay(now)
  const when = at.getTime()
  if (when >= today) {
    return 'today'
  }
  // Seven *whole* days before today, so the window is today plus the seven days
  // that precede it — an item exactly seven days old is in the previous week,
  // not outside it.
  if (when >= today - 7 * DAY_MS) {
    return 'previous-7-days'
  }
  return 'older'
}

/**
 * A short absolute date and time, or `null` when there is nothing to format.
 *
 * Absolute rather than relative (`2 hours ago`) because this stands in for a
 * *name* rather than describing recency, and a label that changed every time a
 * poll re-rendered would be a worse name than a fixed one. An unparseable
 * timestamp is dropped rather than shown raw — the same rule the transcript's
 * own timestamps follow.
 */
export function conversationDate(
  timestamp: string | null | undefined,
  locale?: string,
): string | null {
  if (!timestamp) {
    return null
  }
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) {
    return null
  }
  const date = at.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  const time = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  return `${date}, ${time}`
}

/**
 * The label for a conversation, and never an empty string.
 *
 * A title is used verbatim when there is one: providers return it untruncated
 * and in whatever language it was written, and shortening belongs to the
 * element that knows its own width. `locale` is passed through to the date
 * fallback rather than left to the environment, so a test can assert a format
 * instead of asserting whatever the machine happens to be set to.
 */
export function conversationLabel(
  conversation: Pick<AIConversationSummary, 'title' | 'updatedAt'> | null | undefined,
  locale?: string,
): string {
  const title = conversation?.title?.trim()
  if (title) {
    return title
  }
  const when = conversationDate(conversation?.updatedAt, locale)
  return when === null ? 'Conversation' : `Conversation · ${when}`
}

/**
 * The provider's `preview` as one line a list row can draw.
 *
 * The field is the user's own prompt, passed through verbatim on purpose —
 * measured, it is often a slash command, and sometimes a single character.
 * Two transformations, both about *the line* rather than the text:
 *
 * - **Whitespace is collapsed.** A prompt is frequently multi-line (a pasted
 *   stack trace, a bulleted request), and a newline in a one-line slot either
 *   breaks the row's height or gets clipped mid-word.
 * - **An empty result is `null`, not `''`**, so a row without a preview
 *   degrades to title and time instead of reserving a blank second line.
 *
 * It does **not** truncate to a character count: the row uses CSS truncation,
 * so the cut follows the actual width rather than a guess made here.
 */
export function previewLine(preview: string | null | undefined): string | null {
  if (!preview) {
    return null
  }
  const collapsed = preview.replace(/\s+/g, ' ').trim()
  return collapsed.length === 0 ? null : collapsed
}

/** One conversation's row content, ready to draw. */
export interface ConversationRowContent {
  /** The conversation's identity — the row's key, and what selection speaks. */
  id: string
  label: string
  preview: string | null
  time: string | null
  bucket: DateBucket | null
}

export function rowContent(
  conversation: AIConversationSummary,
  now?: Date,
  locale?: string,
): ConversationRowContent {
  return {
    id: conversation.id,
    label: conversationLabel(conversation, locale),
    preview: previewLine(conversation.preview),
    time: conversationDate(conversation.updatedAt, locale),
    bucket: bucketOf(conversation.updatedAt, now),
  }
}

/**
 * Conversations grouped by bucket, in bucket order, with undated ones last.
 *
 * Bucketed rather than filtered per bucket, so a heading appears once whatever
 * order the provider sent: grouping consecutive runs would emit a second
 * "Older" heading if one arrived out of order, which reads as broken rather
 * than as a sort problem.
 */
export function bucketRows(
  conversations: AIConversationSummary[],
  now?: Date,
  locale?: string,
): { bucket: DateBucket; rows: ConversationRowContent[] }[] {
  const grouped = new Map<DateBucket, ConversationRowContent[]>()
  for (const conversation of conversations) {
    const content = rowContent(conversation, now, locale)
    if (content.bucket === null) {
      continue
    }
    const rows = grouped.get(content.bucket)
    if (rows) {
      rows.push(content)
    } else {
      grouped.set(content.bucket, [content])
    }
  }
  return BUCKET_ORDER.filter((bucket) => (grouped.get(bucket)?.length ?? 0) > 0).map((bucket) => ({
    bucket,
    rows: grouped.get(bucket) as ConversationRowContent[],
  }))
}

/** The conversations with no usable date, which render last and unheaded. */
export function undatedRows(
  conversations: AIConversationSummary[],
  now?: Date,
  locale?: string,
): ConversationRowContent[] {
  return conversations
    .map((conversation) => rowContent(conversation, now, locale))
    .filter((content) => content.bucket === null)
}
