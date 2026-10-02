import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ConversationTranscript } from '../../components/ConversationTranscript'
import type { AIConversationSnapshot } from '../../runtime/ConversationRuntime'
import { toolItem, transcript } from '../fixtures/items'

/**
 * Reading backwards through history, which is a *state* the reader is in, not
 * a gesture they keep making.
 *
 * Reported on staging: after a page finished loading the reader had to scroll
 * again before the next one would start, so paging back through a long
 * conversation was a series of nudges rather than one continuous pull. The
 * cause was that the trigger lived only inside a `scroll` handler — a page
 * landing changed nothing that the handler was watching, so nothing re-ran.
 */

// jsdom implements `scrollTop` but not `scrollTo`, and the scroller calls it
// when something asks it to move. Polyfilled rather than worked around: the
// component is doing nothing wrong, the test environment is just incomplete.
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined
})

function snapshot(overrides: Partial<AIConversationSnapshot> = {}): AIConversationSnapshot {
  return {
    listState: 'ready',
    conversations: [],
    bindingId: 'c1',
    openId: 'c1',
    state: 'ready',
    conversation: null,
    activity: 'inactive',
    items: transcript(4),
    hasMore: true,
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

function viewport(): HTMLElement {
  const element = document.querySelector('[data-slot="message-scroller-viewport"]')
  if (!(element instanceof HTMLElement)) {
    throw new Error('the transcript did not render a scroller viewport')
  }
  return element
}

function renderTranscript(onLoadOlder: () => boolean) {
  const { rerender } = render(
    <ConversationTranscript
      snapshot={snapshot()}
      providerLabel="Claude"
      onLoadOlder={onLoadOlder}
    />,
  )
  const redraw = (overrides: Partial<AIConversationSnapshot>) =>
    rerender(
      <ConversationTranscript
        snapshot={snapshot(overrides)}
        providerLabel="Claude"
        onLoadOlder={onLoadOlder}
      />,
    )
  return { redraw }
}

/** The reader drags the transcript to the top. */
function scrollToTop() {
  const element = viewport()
  element.scrollTop = 0
  fireEvent.scroll(element)
}

describe('reading backwards through the transcript', () => {
  it('keeps fetching while the reader stays at the top', () => {
    const onLoadOlder = vi.fn(() => true)
    const { redraw } = renderTranscript(onLoadOlder)

    scrollToTop()
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    // The page is in flight, then it lands — with more history still behind it.
    // The reader has not moved, and must not have to.
    redraw({ loadingOlder: true })
    redraw({ items: transcript(12), hasMore: true })

    expect(onLoadOlder).toHaveBeenCalledTimes(2)
  })

  it('stops once there is nothing older, and stops while a page is in flight', () => {
    const onLoadOlder = vi.fn(() => true)
    const { redraw } = renderTranscript(onLoadOlder)

    scrollToTop()
    redraw({ loadingOlder: true })
    redraw({ loadingOlder: true })
    // One request at a time: a second would be asking for the same page.
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    redraw({ loadingOlder: false, hasMore: false, items: transcript(20) })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })

  it('does not fetch while the reader is away from the top', () => {
    const onLoadOlder = vi.fn(() => true)
    const { redraw } = renderTranscript(onLoadOlder)

    // Opening a transcript fills it — jsdom has no layout, so the scroller has
    // not yet moved to the end and the transcript reads as "already at the
    // top". Counted rather than denied, so the assertion below is about what
    // the *reader's position* does, which is the claim under test.
    onLoadOlder.mockClear()

    const element = viewport()
    element.scrollTop = 400
    fireEvent.scroll(element)
    redraw({ items: transcript(12), hasMore: true })

    // A refresh that grows the page must not start pulling history for a reader
    // who is reading the middle of the conversation.
    expect(onLoadOlder).not.toHaveBeenCalled()
  })

  it('does not fetch when the page that landed was empty of history', () => {
    const onLoadOlder = vi.fn(() => true)
    render(
      <ConversationTranscript
        snapshot={snapshot({ items: [], hasMore: true })}
        providerLabel="Claude"
        onLoadOlder={onLoadOlder}
      />,
    )

    // Nothing to page back from yet: the first page is still arriving, and
    // asking for "older" before there is a newest would be asking for nothing.
    expect(onLoadOlder).not.toHaveBeenCalled()
    expect(screen.getByTestId('conversation-empty')).toBeDefined()
  })
})

describe('a work group across a prepend', () => {
  it('stays open and keeps focus when an older page extends it', () => {
    // #1363: "load older / prepend 后 disclosure state 和 reading anchor 保持稳定";
    // SC-20 wants it to hold focus too. A group is keyed by its *first* call —
    // load-bearing for the append case, where the group must keep its identity
    // as it grows — and a prepend that reaches across the group's start changes
    // which call that is. The row is then a different element, so the reader's
    // expanded group closes under them and anything focused inside it is gone.
    const { rerender } = render(
      <ConversationTranscript
        snapshot={snapshot({ items: [toolItem('a'), toolItem('b')] })}
        providerLabel="Claude"
        onLoadOlder={() => false}
      />,
    )

    const group = screen.getByTestId('conversation-tool-group') as HTMLDetailsElement
    group.open = true
    const inner = screen.getAllByRole('button')[0] as HTMLElement
    inner.focus()
    expect(document.activeElement).toBe(inner)

    // An older page arrives whose last call is contiguous with the group, so the
    // run now starts at `x` instead of `a`.
    rerender(
      <ConversationTranscript
        snapshot={snapshot({ items: [toolItem('x'), toolItem('a'), toolItem('b')] })}
        providerLabel="Claude"
        onLoadOlder={() => false}
      />,
    )

    const after = screen.getByTestId('conversation-tool-group') as HTMLDetailsElement
    // The same element, so its open state and its focused subtree came with it.
    expect(after).toBe(group)
    expect(after.open).toBe(true)
    expect(after.dataset.count).toBe('3')
    expect(document.activeElement).toBe(inner)
  })
})
