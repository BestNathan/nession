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
      'var(--nession-conversation-fold-control-height)',
    )
  })

  it('reveals on its own hover, not through a group it does not have', () => {
    // The one thing about the reveal that *is* decidable here, and the thing
    // `#1363` round 3 found: this element declared `group/actions` and consumed
    // `group-hover/actions` **on itself**, which compiles to `X:hover X` — the
    // same behaviour under a selector claiming an ancestor that does not exist.
    //
    // That is a structural claim, not a media-query result, so jsdom can settle
    // it — even though the *lit or not* half genuinely cannot be tested here.
    // The action row is a sibling of the answer's row and re-parenting is
    // forbidden (`conversation.md`), so its own hover is the honest trigger, and
    // a selector naming a group would be that claim coming back.
    renderTranscript([userMessage('u1', 'q'), assistantMessage('a1', 'the answer')])

    const actions = screen.getAllByTestId('conversation-turn-actions')[0]
    expect(actions?.className).toContain('pointer-fine:hover:opacity-100')
    expect(actions?.className).not.toContain('group-hover')
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

  it('reserves the row for a turn that has not settled, without lighting it', () => {
    // #1363 round 4: the actions and the process disclosure used to derive the
    // turn's phase separately, so the same frame could keep a process open —
    // "this turn is still working" — and offer a Copy button on an answer that
    // was still being written. "Actions close a turn" was the component's own
    // sentence; the predicate never checked whether the turn had closed.
    //
    // Both halves are asserted, and the first is not decoration: the row is
    // reserved either way, because `conversation.md` forbids anything that
    // appears "as a result of streaming" from moving the content below it. The
    // fix is to withhold the action, not the space.
    renderTranscript([
      userMessage('u1', 'q'),
      assistantMessage('a1', 'still writing', 'streaming'),
    ])

    const row = screen.getByTestId('conversation-turn-actions')
    expect(row).toBeDefined()
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()
  })

  it('withholds the action while a tool the assistant started is still running', () => {
    // The other phase, and the one an answer alone cannot express: the assistant
    // finished a sentence and went back to work. The process is open above it —
    // `isWorking` is what keeps both facts from disagreeing.
    renderTranscript([
      userMessage('u1', 'q'),
      toolItem('t1', { status: 'running' }),
      assistantMessage('a1', 'done so far'),
    ])

    expect(screen.getByTestId('conversation-turn-process')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('conversation-turn-actions')).toBeDefined()
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()
  })

  it('lights the reserved row when the same items settle, without remounting it', () => {
    // The row's identity is what the geometry rule rides on: a settle that
    // remounted it would drop focus, and one that drew a second row would move
    // the content under it. So the assertion is the *element*, held across the
    // phase change — not merely that a button appeared.
    const working = [userMessage('u1', 'q'), assistantMessage('a1', 'still writing', 'streaming')]
    const { rerender } = renderTranscript(working)

    const before = screen.getByTestId('conversation-turn-actions')
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()

    const settled = [userMessage('u1', 'q'), assistantMessage('a1', 'still writing', 'settled')]
    rerender(
      <ConversationTranscript
        snapshot={snapshot({ items: settled })}
        providerLabel="Claude"
        onLoadOlder={() => false}
      />,
    )

    const after = screen.getByTestId('conversation-turn-actions')
    expect(after).toBe(before)
    expect(screen.getByRole('button', { name: /copy/i })).toBeDefined()
  })

  it('does not offer a provider’s unmodelled record as the answer', () => {
    // The answer is the last *message*; a trailing unknown row is not one, so a
    // turn whose only trailing content is unknown has nothing to copy.
    renderTranscript([userMessage('u1', 'q'), unknownItem('x1')])

    expect(screen.queryByTestId('conversation-turn-actions')).toBeNull()
  })
})
