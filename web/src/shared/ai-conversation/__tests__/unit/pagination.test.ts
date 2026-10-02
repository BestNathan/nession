import { describe, expect, it } from 'vitest'
import {
  emptyPositions,
  hasOlder,
  itemsOf,
  withNewest,
  withOlderPage,
} from '../../runtime/pagination'
import { assistantMessage, transcript, userMessage } from '../fixtures/items'

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

    expect(refreshed.newest[0]).toBe(held)
  })

  it('gives a new object for an item that did change', () => {
    const held = assistantMessage('a', 'partial', 'streaming')
    const positions = withNewest(emptyPositions(), { items: [held], nextCursor: null })
    const refreshed = withNewest(positions, {
      items: [assistantMessage('a', 'partial and complete', 'settled')],
      nextCursor: null,
    })

    expect(refreshed.newest[0]).not.toBe(held)
    expect(refreshed.newest[0]).toEqual(
      assistantMessage('a', 'partial and complete', 'settled'),
    )
  })

  it('survives a page with no items', () => {
    const positions = withNewest(emptyPositions(), { items: null, nextCursor: null })
    expect(itemsOf(positions)).toEqual([])
    expect(hasOlder(positions)).toBe(false)
  })
})
