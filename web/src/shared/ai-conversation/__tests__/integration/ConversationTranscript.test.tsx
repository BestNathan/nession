import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConversationTranscript } from '../../components/ConversationTranscript'
import type { AIConversationSnapshot } from '../../runtime/ConversationRuntime'
import type { AIConversationItem } from '../../model/conversation'
import { assistantMessage, toolItem, transcript, unknownItem, userMessage } from '../fixtures/items'

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
    loading: false,
    loadingOlder: false,
    olderError: null,
    error: null,
    ...overrides,
  }
}

function renderTranscript(
  overrides: Partial<AIConversationSnapshot> = {},
  onLoadOlder = vi.fn(() => false),
) {
  render(
    <ConversationTranscript
      snapshot={snapshot(overrides)}
      providerLabel="Claude"
      onLoadOlder={onLoadOlder}
    />,
  )
  return { onLoadOlder }
}

describe('ConversationTranscript', () => {
  it('draws the conversation in order, oldest first', () => {
    renderTranscript({ items: [userMessage('u1', 'first'), assistantMessage('a1', 'second')] })

    const turns = screen.getAllByTestId('conversation-turn')
    expect(turns.map((turn) => turn.dataset.role)).toEqual(['user', 'assistant'])
  })

  it('collapses a run of calls into one row that describes the work', () => {
    renderTranscript({
      items: [
        toolItem('t1', { name: 'Bash', category: 'command' }),
        toolItem('t2', { name: 'Read', category: 'read' }),
        toolItem('t3', { name: 'Grep', category: 'search' }),
      ],
    })

    const summary = screen.getByTestId('conversation-tool-group-summary')
    // The summary counts categories. The *body* still names each call — a
    // reader who opens the group is asking which tools ran — so the assertion
    // is about the summary, not about the group.
    expect(summary.textContent).toBe('1 command · 1 file read · 1 search')
    expect(summary.textContent).not.toContain('Bash')
    expect(screen.getByTestId('conversation-tool-group').textContent).toContain('Bash')
  })

  it('calls out a failure inside a collapsed group', () => {
    renderTranscript({
      items: [
        toolItem('t1', { category: 'command' }),
        toolItem('t2', { category: 'command', status: 'error' }),
      ],
    })

    expect(screen.getByTestId('conversation-tool-group-failed').textContent).toContain('1 failed')
  })

  it('leaves a lone call as its own row rather than a group of one', () => {
    renderTranscript({ items: [toolItem('t1')] })

    expect(screen.queryByTestId('conversation-tool-group')).toBeNull()
    expect(screen.getByTestId('conversation-tool')).toBeDefined()
  })

  it('states an unmodelled record instead of dropping it', () => {
    renderTranscript({ items: [unknownItem('x1')] })

    expect(screen.getByTestId('conversation-unknown')).toBeDefined()
  })

  it('marks only the trailing assistant message as streaming', () => {
    const items: AIConversationItem[] = [
      assistantMessage('a1', 'settled earlier'),
      userMessage('u1', 'and then?'),
      assistantMessage('a2', 'still going'),
    ]
    renderTranscript({ items, partialTail: true })

    const bodies = screen.getAllByTestId('conversation-assistant-body')
    expect(bodies[0]?.dataset.streaming).toBeUndefined()
    expect(bodies[1]?.dataset.streaming).toBe('true')
  })

  it('says the conversation is loading before anything arrives', () => {
    renderTranscript({ loading: true, items: [] })

    expect(screen.getByTestId('conversation-loading')).toBeDefined()
  })

  it('says the conversation is empty once it has loaded and has nothing', () => {
    renderTranscript({ loading: false, items: [] })

    // Unavailable is not empty, and empty is not an error.
    expect(screen.getByTestId('conversation-empty')).toBeDefined()
  })

  it('keeps not-found distinct from a failure', () => {
    const { unmount } = render(
      <ConversationTranscript
        snapshot={snapshot({ state: 'not_found', loading: false })}
        providerLabel="Claude"
        onLoadOlder={() => false}
      />,
    )
    expect(screen.getByTestId('conversation-missing')).toBeDefined()
    expect(screen.queryByTestId('conversation-error')).toBeNull()
    unmount()

    // A deleted conversation is not a failure to read one, and a read that
    // failed is not a conversation that does not exist.
    render(
      <ConversationTranscript
        snapshot={snapshot({ state: 'error', error: 'the host refused', loading: false })}
        providerLabel="Claude"
        onLoadOlder={() => false}
      />,
    )
    expect(screen.getByTestId('conversation-error').textContent).toContain('the host refused')
  })

  it('counts the records it could not show', () => {
    renderTranscript({ items: transcript(2), skipped: 3 })

    // Distinct from the header's count, which says the same thing beside the
    // title — one name for both would make this assertion ambiguous.
    expect(screen.getByTestId('conversation-skipped-records').textContent).toContain(
      '3 records were not shown',
    )
  })

  it('keeps the readable conversation when an older page fails, and offers a retry', async () => {
    const { onLoadOlder } = renderTranscript({
      items: transcript(2),
      hasMore: true,
      olderError: 'the page could not be read',
    })

    // The reader still has a conversation; taking it away because one page
    // failed would punish them for the network.
    expect(screen.getAllByTestId('conversation-turn')).toHaveLength(2)
    expect(screen.getByTestId('conversation-older-error').textContent).toContain(
      'the page could not be read',
    )

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onLoadOlder).toHaveBeenCalled()
  })

  it('shows the older-page spinner without replacing the transcript', () => {
    renderTranscript({ items: transcript(2), hasMore: true, loadingOlder: true })

    expect(screen.getByTestId('conversation-loading-older')).toBeDefined()
    expect(screen.getAllByTestId('conversation-turn')).toHaveLength(2)
  })
})
