/**
 * The window of a conversation the client is holding, and where "older"
 * continues from.
 *
 * ## Why one window, and not a newest page plus older pages
 *
 * It was two lists — the newest page, and the pages loaded behind it — on the
 * reasoning that a refresh re-reads the newest page and must not disturb what
 * the reader scrolled back to. The reasoning was right and the shape was wrong.
 *
 * The newest page is a **fixed-size tail**. When the conversation grows, its
 * window slides forward and the item that used to head it stops being mentioned
 * by any response. Two disjoint segments then lose it between them: the refresh
 * replaces its own half, the item belongs to neither, and a message the reader
 * is looking at disappears on the next poll. Measured with a page size of three,
 * loading one older page, and appending one item:
 *
 *     held   older  = [m0, m1, m2]
 *            newest = [m3, m4, m5]
 *     append m6   ->  tail page is now [m4, m5, m6]
 *     result            [m0, m1, m2, m4, m5, m6]      m3 gone
 *
 * One merged window is the shape that matches how a provider actually answers:
 * a refresh is reconciled *into* what is held (`merging`, by id) instead of
 * being allowed to redefine a range. What the reader has loaded, they keep.
 *
 * ## Why `paged` is a flag and not `items.length > 0`
 *
 * `cursor` answers "where does older continue from". Before the reader pages
 * back, that is the newest page's own `nextCursor`; afterwards it is theirs,
 * and refreshes must leave it alone — the newest page's cursor points at the
 * newest page's *start*, so following it after scrolling back would re-fetch
 * what is already on screen. A page that legitimately returned zero items would
 * make `items.length > 0` the wrong test, so the flag says it directly.
 *
 * This module is the provider-agnostic form of behaviour #1222 measured in
 * `capabilities/claude-code/model/messagePositions.ts`; that file's tests are
 * the specification this one is held to.
 */

import { merging } from './reconcile'
import type { AIConversationItem } from '../model/conversation'

export interface ConversationPositions {
  /** Everything the client is holding, oldest first, each id at most once. */
  items: AIConversationItem[]
  /** Where older continues from; `null` when there is nothing older. */
  cursor: string | null
  /** Whether the reader has paged back at least once. */
  paged: boolean
}

export function emptyPositions(): ConversationPositions {
  return { items: [], cursor: null, paged: false }
}

/** The two fields a page contributes to the window. */
interface PageSlice {
  items?: AIConversationItem[] | null
  nextCursor?: string | null
}

/**
 * A fresh newest page: reconciled into the window, not substituted for a range.
 *
 * Items the page restates are updated in place — keeping their object identity
 * when nothing changed, which is what keeps a poll from re-parsing the Markdown
 * of a whole page — items it introduces are appended, and items it has stopped
 * mentioning stay where they are.
 */
export function withNewest(
  current: ConversationPositions,
  page: PageSlice,
): ConversationPositions {
  return {
    items: merging(current.items, page.items ?? []),
    cursor: current.paged ? current.cursor : (page.nextCursor ?? null),
    paged: current.paged,
  }
}

/**
 * A page fetched with the older cursor: it is older than everything held, so it
 * goes in front. Its own items are oldest-first within the page already.
 *
 * Filtered against the window first. A cursor is the provider's to define and
 * nothing forbids it from overlapping what is already loaded; without this an
 * overlap would be a duplicated message, which is the same class of bug as the
 * one above with the opposite sign.
 */
export function withOlderPage(
  current: ConversationPositions,
  page: PageSlice,
): ConversationPositions {
  const held = new Set(current.items.map((item) => item.id))
  const arriving = (page.items ?? []).filter((item) => !held.has(item.id))
  return {
    items: [...arriving, ...current.items],
    cursor: page.nextCursor ?? null,
    paged: true,
  }
}

/** Everything to render, oldest first. */
export function itemsOf(positions: ConversationPositions): AIConversationItem[] {
  return positions.items
}

/** Whether a page of older items can still be fetched. */
export function hasOlder(positions: ConversationPositions): boolean {
  return positions.cursor !== null
}
