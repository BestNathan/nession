import { describe, expect, it } from 'vitest'
import {
  emptyPositions,
  hasOlder,
  itemsOf,
  withNewest,
  withOlderPage,
} from '../../runtime/pagination'
import { assistantMessage, toolItem, transcript, userMessage } from '../fixtures/items'

describe('conversation positions', () => {
  it('replaces the newest page and keeps everything behind it', () => {
    const paged = withOlderPage(
      withNewest(emptyPositions(), { items: transcript(4), nextCursor: null }),
      { items: transcript(2, 'old'), nextCursor: null },
    )
    const refreshed = withNewest(paged, { items: transcript(4), nextCursor: 'x' })

    expect(itemsOf(refreshed).map((item) => item.id)).toEqual([
      'old0',
      'old1',
      'm0',
      'm1',
      'm2',
      'm3',
    ])
  })

  it('keeps every loaded item when the provider’s tail page slides forward', () => {
    // The provider reads a fixed-size tail page. Appending one item slides that
    // page's start forward, so the item that used to head it is no longer
    // mentioned by any refresh — and the reader has already paged in behind it.
    // Losing it here is losing something they can see.
    const all = transcript(7) // m0 … m6

    const newest = withNewest(emptyPositions(), {
      items: all.slice(3, 6), // the tail page: m3, m4, m5
      nextCursor: 'a',
    })
    const paged = withOlderPage(newest, {
      items: all.slice(0, 3), // m0, m1, m2
      nextCursor: 'older',
    })

    // m6 arrives. The tail page is now m4, m5, m6 — m3 has fallen off it.
    const refreshed = withNewest(paged, {
      items: all.slice(4, 7),
      nextCursor: 'a',
    })

    const ids = itemsOf(refreshed).map((item) => item.id)
    expect(ids).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'])
    // Present exactly once: the overlap between the page and the window is
    // reconciled, not appended.
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('does not duplicate an item an older page overlaps', () => {
    // A cursor is the provider's to define, and nothing forbids one that reaches
    // back into what is already on screen. A duplicate message is the same class
    // of bug as a lost one, with the opposite sign.
    const all = transcript(4) // m0 … m3

    const first = withNewest(emptyPositions(), {
      items: all.slice(2, 4), // m2, m3
      nextCursor: 'a',
    })
    const older = withOlderPage(first, {
      items: all.slice(0, 3), // m0, m1, m2 — m2 is already held
      nextCursor: null,
    })

    const ids = itemsOf(older).map((item) => item.id)
    expect(ids).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('reconciles a changed item when an older page overlaps the loaded window', () => {
    const first = withNewest(emptyPositions(), {
      items: [
        toolItem('t1', { status: 'running', output: null }),
        assistantMessage('a1', 'waiting'),
      ],
      nextCursor: 'a',
    })
    const older = withOlderPage(first, {
      items: [
        userMessage('u0', 'before'),
        toolItem('t1', {
          status: 'success',
          output: { text: 'done', kind: 'text', truncated: false },
        }),
      ],
      nextCursor: null,
    })

    expect(itemsOf(older).map((item) => item.id)).toEqual(['u0', 't1', 'a1'])
    expect(itemsOf(older)[1]).toMatchObject({ id: 't1', status: 'success' })
  })

  it('keeps provider-reported skipped records with the merged loaded window', () => {
    const newest = withNewest(emptyPositions(), {
      items: transcript(2),
      nextCursor: 'a',
      skipped: 1,
    })
    const older = withOlderPage(newest, {
      items: transcript(2, 'old'),
      nextCursor: null,
      skipped: 3,
    })
    const refreshed = withNewest(older, {
      items: transcript(2),
      nextCursor: 'a',
      skipped: 0,
    })

    expect(refreshed.skipped).toBe(3)
  })

  it('follows the newest page cursor only while the reader has not paged back', () => {
    const first = withNewest(emptyPositions(), { items: transcript(2), nextCursor: 'a' })
    expect(first.cursor).toBe('a')

    const second = withNewest(first, { items: transcript(2), nextCursor: 'b' })
    expect(second.cursor).toBe('b')
  })

  it('leaves the cursor alone once the reader has paged back', () => {
    const first = withNewest(emptyPositions(), { items: transcript(2), nextCursor: 'a' })
    const paged = withOlderPage(first, { items: transcript(2, 'old'), nextCursor: 'older' })
    expect(paged.cursor).toBe('older')

    // A refresh answers with the newest page's own cursor, which points at the
    // start of the newest page. Following it here would re-fetch what is
    // already on screen, so it must be ignored.
    const refreshed = withNewest(paged, { items: transcript(2), nextCursor: 'a' })
    expect(refreshed.cursor).toBe('older')
  })

  it('puts an older page in front, oldest-first', () => {
    const positions = withNewest(emptyPositions(), { items: transcript(2), nextCursor: 'a' })
    const older = withOlderPage(positions, {
      items: [userMessage('old0', 'q'), assistantMessage('old1', 'a')],
      nextCursor: null,
    })

    expect(itemsOf(older).map((item) => item.id)).toEqual(['old0', 'old1', 'm0', 'm1'])
    expect(hasOlder(older)).toBe(false)
  })

  it('stops offering older when the oldest page has no cursor', () => {
    const positions = withNewest(emptyPositions(), { items: transcript(1), nextCursor: null })
    expect(hasOlder(positions)).toBe(false)
  })

  it('gives back the previous object for an item that did not change', () => {
    const held = userMessage('a', 'unchanged')
    const positions = withNewest(emptyPositions(), { items: [held], nextCursor: null })
    const refreshed = withNewest(positions, {
      // A different object with the same content, as a JSON round-trip produces
      // on every poll.
      items: [userMessage('a', 'unchanged')],
      nextCursor: null,
    })

    expect(refreshed.items[0]).toBe(held)
  })

  it('gives a new object for an item that did change', () => {
    const held = assistantMessage('a', 'partial', 'streaming')
    const positions = withNewest(emptyPositions(), { items: [held], nextCursor: null })
    const refreshed = withNewest(positions, {
      items: [assistantMessage('a', 'partial and complete', 'settled')],
      nextCursor: null,
    })

    expect(refreshed.items[0]).not.toBe(held)
    expect(refreshed.items[0]).toEqual(
      assistantMessage('a', 'partial and complete', 'settled'),
    )
  })

  it('survives a page with no items', () => {
    const positions = withNewest(emptyPositions(), { items: null, nextCursor: null })
    expect(itemsOf(positions)).toEqual([])
    expect(hasOlder(positions)).toBe(false)
  })
})
