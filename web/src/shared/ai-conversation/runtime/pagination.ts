/**
 * The window of a conversation the client is holding, and where "older"
 * continues from.
 *
 * ## Why two lists rather than one
 *
 * The newest page is re-read on every refresh, but a reader who has scrolled
 * back holds items that response does not mention. Keeping one list and
 * replacing it on each refresh would silently throw their older pages away
 * every few seconds; appending to one list would duplicate everything the
 * refresh re-sends. So the newest page is tracked apart from the pages loaded
 * behind it, and [`itemsOf`] joins the two.
 *
 * ## Why `paged` is a flag and not `older.length > 0`
 *
 * `cursor` answers "where does older continue from". Before the reader pages
 * back, that is the newest page's own `nextCursor`; afterwards it is theirs,
 * and refreshes must leave it alone — the newest page's cursor points at the
 * newest page's *start*, so following it after scrolling back would re-fetch
 * what is already on screen. A page that legitimately returned zero items would
 * make `older.length > 0` the wrong test, so the flag says it directly.
 *
 * This module is the provider-agnostic form of behaviour #1222 measured in
 * `capabilities/claude-code/model/messagePositions.ts`; that file's tests are
 * the specification this one is held to.
 */

import { reusing } from './reconcile'
import type { AIConversationItem } from '../model/conversation'

export interface ConversationPositions {
  /** The most recently read newest page — replaced wholesale by each refresh. */
  newest: AIConversationItem[]
  /** Pages loaded behind it, oldest-first, in the order they were fetched. */
  older: AIConversationItem[]
  /** Where older continues from; `null` when there is nothing older. */
  cursor: string | null
  /** Whether the reader has paged back at least once. */
  paged: boolean
}

export function emptyPositions(): ConversationPositions {
  return { newest: [], older: [], cursor: null, paged: false }
}

/** The two fields a page contributes to the window. */
interface PageSlice {
  items?: AIConversationItem[] | null
  nextCursor?: string | null
}

/**
 * A fresh newest page: replace it, keep everything behind it.
 *
 * Object identity is preserved for the items that did not change, which is what
 * keeps a poll from re-parsing the Markdown of a whole page.
 */
export function withNewest(
  current: ConversationPositions,
  page: PageSlice,
): ConversationPositions {
  return {
    newest: reusing(current.newest, page.items ?? []),
    older: current.older,
    cursor: current.paged ? current.cursor : (page.nextCursor ?? null),
    paged: current.paged,
  }
}

/**
 * A page fetched with the older cursor: it is older than everything held, so it
 * goes in front. Its own items are oldest-first within the page already.
 */
export function withOlderPage(
  current: ConversationPositions,
  page: PageSlice,
): ConversationPositions {
  return {
    newest: current.newest,
    older: [...(page.items ?? []), ...current.older],
    cursor: page.nextCursor ?? null,
    paged: true,
  }
}

/** Everything to render, oldest first. */
export function itemsOf(positions: ConversationPositions): AIConversationItem[] {
  return [...positions.older, ...positions.newest]
}

/** Whether a page of older items can still be fetched. */
export function hasOlder(positions: ConversationPositions): boolean {
  return positions.cursor !== null
}
