import { describe, expect, it } from 'vitest';
import {
  emptyPositions,
  hasOlder,
  itemsOf,
  withNewest,
  withOlderPage,
  type ConversationItems,
} from '../../conversationPositions';

function items(...ids: string[]): ConversationItems {
  return ids.map((id) => ({ id, kind: 'user' as const, text: id }));
}

const ids = (list: ConversationItems) => list.map((item) => item.id);

describe('conversationPositions', () => {
  it('puts a loaded older page in front of what is already there', () => {
    // The page is *older* than everything held, and its own items are
    // oldest-first — so it goes in front, unreordered.
    let positions = withNewest(emptyPositions(), { items: items('c', 'd') });
    positions = withOlderPage(positions, { items: items('a', 'b') });

    expect(ids(itemsOf(positions))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps older pages when the newest page is replaced by a poll', () => {
    // The claim the whole two-list design exists for: a user who scrolled back
    // must still have their older pages after the next poll, or scrolling back
    // would be undone every few seconds.
    let positions = withNewest(emptyPositions(), { items: items('c', 'd'), next_cursor: '2' });
    positions = withOlderPage(positions, { items: items('a', 'b'), next_cursor: null });
    // The transcript grew, so the newest page now carries an extra turn.
    positions = withNewest(positions, { items: items('c', 'd', 'e'), next_cursor: '2' });

    expect(ids(itemsOf(positions))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('does not move the older cursor once the user has paged back', () => {
    // Before paging, "older" continues from the newest page's own cursor. After
    // paging it is the user's, and a poll must leave it alone — the newest
    // page's cursor points at the newest page's start, so following it would
    // re-fetch what is already on screen.
    let positions = withNewest(emptyPositions(), { items: items('c'), next_cursor: '2' });
    expect(positions.cursor).toBe('2');

    positions = withOlderPage(positions, { items: items('a'), next_cursor: '0' });
    expect(positions.cursor).toBe('0');

    positions = withNewest(positions, { items: items('c', 'd'), next_cursor: '3' });
    expect(positions.cursor).toBe('0');
  });

  it('takes the newest page when nothing has been paged back', () => {
    let positions = withNewest(emptyPositions(), { items: items('a'), next_cursor: '1' });
    positions = withNewest(positions, { items: items('a', 'b'), next_cursor: '2' });

    expect(ids(itemsOf(positions))).toEqual(['a', 'b']);
    expect(positions.cursor).toBe('2');
  });

  it('stops offering older pages when the transcript has no earlier cursor', () => {
    const positions = withNewest(emptyPositions(), { items: items('a') });
    expect(hasOlder(positions)).toBe(false);
    expect(hasOlder(withNewest(positions, { items: items('a'), next_cursor: '1' }))).toBe(true);
  });

  it('treats a page with no items as a page, not as the end of paging', () => {
    // `paged` is a flag rather than `older.length > 0` for this case: a page that
    // legitimately returned nothing must not make the next poll adopt the newest
    // page's cursor and quietly reset where older continues from.
    let positions = withNewest(emptyPositions(), { items: items('c'), next_cursor: '5' });
    positions = withOlderPage(positions, { items: [], next_cursor: '4' });
    expect(positions.paged).toBe(true);

    positions = withNewest(positions, { items: items('c', 'd'), next_cursor: '6' });
    expect(positions.cursor).toBe('4');
  });
});
