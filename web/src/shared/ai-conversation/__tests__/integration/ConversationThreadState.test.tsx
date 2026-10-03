import { beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConversationTranscript } from '../../components/ConversationTranscript'
import type { AIConversationSnapshot } from '../../runtime/ConversationRuntime'
import { transcript } from '../fixtures/items'

/**
 * The answer a read gave, versus the state the surface drew.
 *
 * `ConversationState.tsx` states the rule this file enforces — *"Unavailable is
 * not empty"* — and the review found the transcript had no arm for it at all, so
 * two wrong states followed from one missing branch:
 *
 * - a first read that answered `unavailable` was told **"This conversation has
 *   no messages yet."**, which is a specific claim the provider explicitly
 *   declined to make;
 * - a thread that had been readable and then answered `unavailable` kept
 *   rendering its old rows, which is worse — stale content and live content are
 *   the same pixels, so the reader has no way to tell.
 *
 * Both are one branch apart, so both are asserted here, along with the
 * neighbours that must not have moved when it was added.
 */

// jsdom implements `scrollTop` but not `scrollTo`, and the scroller calls it.
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined
})

function snapshot(overrides: Partial<AIConversationSnapshot> = {}): AIConversationSnapshot {
  const openId = overrides.openId ?? 'c1'
  return {
    listState: 'ready',
    conversations: [],
    bindingId: 'c1',
    openId,
    // The runtime derives this from its own identity, the context key and
    // the open id. A fixture has only the last, and a key that follows
    // `openId` is enough to make a conversation switch look like one —
    // which is the only thing this fixture needs it to do.
    conversationKey: openId === null ? null : `fixture:${openId}`,
    state: 'ready',
    conversation: null,
    activity: 'inactive',
    items: [],
    hasMore: false,
    partialTail: false,
    skipped: 0,
    listLoading: false,
    threadLoading: false,
    loadingOlder: false,
    olderError: null,
    listError: null,
    threadError: null,
    ...overrides,
  }
}

function renderTranscript(
  overrides: Partial<AIConversationSnapshot> = {},
  onReload?: () => void,
) {
  const { rerender } = render(
    <ConversationTranscript
      snapshot={snapshot(overrides)}
      providerLabel="Claude"
      onLoadOlder={() => false}
      onReload={onReload}
    />,
  )
  const redraw = (next: Partial<AIConversationSnapshot>) =>
    rerender(
      <ConversationTranscript
        snapshot={snapshot(next)}
        providerLabel="Claude"
        onLoadOlder={() => false}
        onReload={onReload}
      />,
    )
  return { redraw }
}

describe('a thread the provider answered unavailable', () => {
  it('says it cannot be read, not that it is empty', () => {
    renderTranscript({ state: 'unavailable', items: [] })

    expect(screen.getByTestId('conversation-unavailable')).toBeDefined()
    // The specific sentence that must not appear: it is a claim about the
    // conversation's contents, and the provider said nothing about them.
    expect(screen.queryByTestId('conversation-empty')).toBeNull()
    expect(screen.queryByTestId('conversation-missing')).toBeNull()
  })

  it('does not keep drawing a readable thread as if it were current', () => {
    const { redraw } = renderTranscript({ items: transcript(4) })
    expect(screen.getAllByTestId('conversation-turn').length).toBeGreaterThan(0)

    // The thread was readable; the re-read could not be made.
    redraw({ state: 'unavailable', items: transcript(4) })

    expect(screen.getByTestId('conversation-unavailable')).toBeDefined()
    // Stale rows must not survive as *current* content. They are still held
    // upstream for recovery — what must not happen is presenting them here.
    expect(screen.queryAllByTestId('conversation-turn')).toEqual([])
  })

  it('offers the reader a way to ask again', async () => {
    // Load-bearing: the runtime stops refreshing on a non-ready answer, so
    // without this the state is a dead end only a page reload escapes.
    const onReload = vi.fn()
    renderTranscript({ state: 'unavailable', items: [] }, onReload)

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(onReload).toHaveBeenCalledTimes(1)
  })
})

describe('the states unavailable must stay distinct from', () => {
  it('still says missing for a conversation that is gone', () => {
    renderTranscript({ state: 'not_found', items: [] })

    expect(screen.getByTestId('conversation-missing')).toBeDefined()
    expect(screen.queryByTestId('conversation-unavailable')).toBeNull()
  })

  it('still says empty for a conversation that really has nothing', () => {
    renderTranscript({ state: 'ready', items: [] })

    expect(screen.getByTestId('conversation-empty')).toBeDefined()
    expect(screen.queryByTestId('conversation-unavailable')).toBeNull()
  })

  it('still says failed for a read that failed', () => {
    renderTranscript({ threadError: 'The conversation could not be read', items: [] })

    expect(screen.getByTestId('conversation-error')).toBeDefined()
    expect(screen.queryByTestId('conversation-unavailable')).toBeNull()
  })
})
