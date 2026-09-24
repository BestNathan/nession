import type { ClaudeCodeConversationResponse } from '../types';

export type ConversationItems = NonNullable<ClaudeCodeConversationResponse['items']>;

/** One page of the contract, as this module needs it. */
type Page = {
  items?: ConversationItems | null;
  next_cursor?: string | null;
};

/**
 * The two ends of a conversation the client is holding, and where older
 * continues from.
 *
 * ## Why two lists rather than one
 *
 * The newest page is re-read on every poll (`#1005` criterion 3), but a user who
 * has scrolled back holds items that response does not mention. Keeping one list
 * and replacing it on each poll would silently throw their older pages away
 * every few seconds; appending to one list would duplicate everything the poll
 * re-sends. So the newest page is tracked apart from the pages loaded behind it,
 * and `items()` is the two joined.
 *
 * ## Why `paged` is a flag and not `older.length > 0`
 *
 * `cursor` answers "where does older continue from". Before the user pages back,
 * that is the newest page's own `next_cursor`; afterwards it is theirs, and polls
 * must leave it alone — the newest page's cursor points at the newest page's
 * start, so following it after scrolling back would re-fetch what is already on
 * screen. A page that legitimately returned zero items would make
 * `older.length > 0` the wrong test, so the flag says it directly.
 */
export interface Positions {
  newest: ConversationItems;
  older: ConversationItems;
  cursor: string | null;
  paged: boolean;
}

export function emptyPositions(): Positions {
  return { newest: [], older: [], cursor: null, paged: false };
}

/**
 * A fresh newest page: replace it, keep everything behind it.
 *
 * The older cursor moves only while the user has not paged back — see the note
 * on [`Positions`].
 */
export function withNewest(current: Positions, page: Page): Positions {
  return {
    newest: page.items ?? [],
    older: current.older,
    cursor: current.paged ? current.cursor : (page.next_cursor ?? null),
    paged: current.paged,
  };
}

/**
 * A page fetched with the older cursor: it is older than everything held, so it
 * goes in front. Its own items are oldest-first within the page already.
 */
export function withOlderPage(current: Positions, page: Page): Positions {
  return {
    newest: current.newest,
    older: [...(page.items ?? []), ...current.older],
    cursor: page.next_cursor ?? null,
    paged: true,
  };
}

/** Everything to render, oldest first. */
export function itemsOf(positions: Positions): ConversationItems {
  return [...positions.older, ...positions.newest];
}

/** Whether a page of older items can still be fetched. */
export function hasOlder(positions: Positions): boolean {
  return positions.cursor !== null;
}
