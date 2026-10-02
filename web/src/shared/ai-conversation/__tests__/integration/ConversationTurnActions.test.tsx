import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConversationTranscript } from '../../components/ConversationTranscript'
import type { AIConversationSnapshot } from '../../runtime/ConversationRuntime'
import { assistantMessage, toolItem, unknownItem, userMessage } from '../fixtures/items'

/**
 * A turn's closing actions.
 *
 * ## What is not tested here
 *
 * The reveal itself is a media query — `pointer-fine` — and jsdom resolves no
 * media queries, so whether the row fades on a pointer device and stays lit on a
 * touch one is the browser gate's to check. What is checked here is everything
 * that decides *whether the row exists and what it does*, which is where a
 * regression would actually start.
 */

const { copyToClipboard } = vi.hoisted(() => ({
  copyToClipboard: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/shared/lib/clipboard', () => ({ copyToClipboard }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function snapshot(overrides: Partial<AIConversationSnapshot> = {}): AIConversationSnapshot {
  return {
    listState: 'ready',
    conversations: [],
    bindingId: 'c1',
    openId: 'c1',
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

function renderTranscript(items: AIConversationSnapshot['items'], overrides = {}) {
  return render(
    <ConversationTranscript
      snapshot={snapshot({ items, ...overrides })}
      providerLabel="Claude"
      onLoadOlder={() => false}
    />,
  )
}

describe('a turn’s actions', () => {
  it('closes a turn that has an answer', () => {
    renderTranscript([userMessage('u1', 'q'), assistantMessage('a1', 'the answer')])

    const actions = screen.getAllByTestId('conversation-turn-actions')
    expect(actions).toHaveLength(1)
    // It reserves its own height rather than appearing on hover: a row that
    // appeared would move the answer under the reader's pointer.
    expect(actions[0]?.getAttribute('style')).toContain(
      'var(--conversation-fold-control-height)',
    )
  })

  it('is not drawn for a turn that has not answered', () => {
    // Nothing to copy, and nothing to say about it.
    renderTranscript([userMessage('u1', 'q'), toolItem('t1'), toolItem('t2')])

    expect(screen.queryByTestId('conversation-turn-actions')).toBeNull()
  })

  it('is drawn once per turn, not once per row', () => {
    renderTranscript([
      userMessage('u1', 'q'),
      toolItem('t1'),
      toolItem('t2'),
      assistantMessage('a1', 'first'),
      userMessage('u2', 'q'),
      assistantMessage('a2', 'second'),
    ])

    expect(screen.getAllByTestId('conversation-turn-actions')).toHaveLength(2)
  })

  it('copies the answer the reader is looking at', async () => {
    renderTranscript([userMessage('u1', 'q'), assistantMessage('a1', 'the answer')])

    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('the answer'))
  })

  it('copies only what the model could name', async () => {
    // A placeholder in someone's clipboard is worse than less text: they paste
    // it without reading it.
    renderTranscript([
      userMessage('u1', 'q'),
      {
        ...assistantMessage('a1', 'kept'),
        content: [{ type: 'text', text: 'kept' }, { type: 'unknown', sourceType: 'diagram' }],
      },
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('kept'))
  })

  it('does not offer a provider’s unmodelled record as the answer', () => {
    // The answer is the last *message*; a trailing unknown row is not one, so a
    // turn whose only trailing content is unknown has nothing to copy.
    renderTranscript([userMessage('u1', 'q'), unknownItem('x1')])

    expect(screen.queryByTestId('conversation-turn-actions')).toBeNull()
  })
})
