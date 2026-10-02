import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ConversationTranscript } from '../../components/ConversationTranscript'
import type { AIConversationSnapshot } from '../../runtime/ConversationRuntime'
import { assistantMessage, toolItem, userMessage } from '../fixtures/items'

/**
 * The turn's process control: one line per turn, folding the work behind it.
 *
 * ## Why this asserts `hidden` and not `toBeVisible`
 *
 * Measured, not assumed: jest-dom reports a `<details>` as *not visible* whenever
 * it is closed, whatever its ancestors say. So `expect(group).not.toBeVisible()`
 * passes on every folded turn — and would have kept passing if this component
 * hid nothing at all. The assertion was vacuous in exactly the direction the
 * change moves.
 *
 * The transcript's own mechanism is the `hidden` attribute on the row, so that
 * is what is asserted here. The pixels are the browser gate's job.
 */

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

// Two calls per turn: one call is deliberately not a group, so a lone
// `ToolActivity` row would leave these assertions with nothing to look at.
const twoTurns = [
  userMessage('u1', 'first question'),
  toolItem('t1'),
  toolItem('t1b'),
  assistantMessage('a1', 'first answer'),
  userMessage('u2', 'second question'),
  toolItem('t2'),
  toolItem('t2b'),
  assistantMessage('a2', 'second answer'),
]

function renderTranscript(overrides: Partial<AIConversationSnapshot> = {}) {
  return render(
    <ConversationTranscript
      snapshot={snapshot({ items: twoTurns, ...overrides })}
      providerLabel="Claude"
      onLoadOlder={() => false}
    />,
  )
}

/** The row a piece of content is drawn in — what folding hides. */
function rowOf(element: HTMLElement): Element | null {
  return element.closest('[data-slot="message-scroller-item"]')
}

function groupRows(): Element[] {
  return screen.getAllByTestId('conversation-tool-group').map((group) => {
    const row = rowOf(group)
    if (row === null) {
      throw new Error('a tool group was drawn outside a transcript row')
    }
    return row
  })
}

describe('the turn process control', () => {
  it('folds the work of every finished turn and leaves the answers', () => {
    renderTranscript()

    expect(screen.getAllByTestId('conversation-turn-process')).toHaveLength(2)
    // The reader came for the answer, and the question stays: it is what the
    // turn *is*, not part of its work.
    expect(screen.getByText('first answer')).toBeVisible()
    expect(screen.getByText('second answer')).toBeVisible()
    expect(screen.getByText('first question')).toBeVisible()
    for (const row of groupRows()) {
      expect(row).toHaveAttribute('hidden')
    }
  })

  it('opens a turn’s work on the control, and closes it again', () => {
    renderTranscript()
    const [first] = screen.getAllByTestId('conversation-turn-process')
    if (first === undefined) {
      throw new Error('no turn process control rendered')
    }

    fireEvent.click(first)
    // The first turn's work is shown and the second's is still folded, so this
    // also says the control opens its own turn rather than every one.
    const [firstGroup, secondGroup] = groupRows()
    expect(firstGroup).not.toHaveAttribute('hidden')
    expect(secondGroup).toHaveAttribute('hidden')

    fireEvent.click(first)
    for (const row of groupRows()) {
      expect(row).toHaveAttribute('hidden')
    }
  })

  it('leaves the turn being worked on open', () => {
    // Folding something as it is written hides the only thing happening.
    renderTranscript({ partialTail: true })

    const controls = screen.getAllByTestId('conversation-turn-process')
    expect(controls[0]).not.toHaveAttribute('data-open')
    expect(controls[1]).toHaveAttribute('data-open', 'true')
    expect(groupRows()[1]).not.toHaveAttribute('hidden')
  })

  it('shows the work of a turn that has not answered yet', () => {
    // The next question arrives before this one was answered. The turn has no
    // answer, so its work is the only thing it has to show — and folding it
    // renders the turn as a question and then silence.
    renderTranscript({
      items: [
        userMessage('u1', 'q'),
        toolItem('t1'),
        toolItem('t2'),
        userMessage('u2', 'q2'),
        assistantMessage('a1', 'answer'),
      ],
    })

    expect(groupRows()[0]).not.toHaveAttribute('hidden')
  })

  it('keeps a turn open while its answer is still arriving', () => {
    // The provider says the answer is streaming and the page says nothing about
    // itself. Believing the provider is the same precedence `isStreaming`
    // applies to the message, and it is what keeps the work in view while the
    // answer it is producing is being written.
    renderTranscript({
      items: [
        userMessage('u1', 'q'),
        toolItem('t1'),
        toolItem('t2'),
        assistantMessage('a1', 'partial', 'streaming'),
      ],
      partialTail: false,
    })

    expect(groupRows()[0]).not.toHaveAttribute('hidden')
  })

  it('says how long the work took only when the provider stated both ends', () => {
    renderTranscript({
      items: [
        { ...userMessage('u1', 'q'), timestamp: '2026-10-02T10:00:00.000Z' },
        toolItem('t1'),
        { ...assistantMessage('a1', 'a'), timestamp: '2026-10-02T10:00:12.000Z' },
      ],
    })

    expect(screen.getByTestId('conversation-turn-process')).toHaveTextContent('Worked for 12s')
  })

  it('says only that it worked when the provider did not timestamp it', () => {
    renderTranscript({ items: [userMessage('u1', 'q'), toolItem('t1'), assistantMessage('a1', 'a')] })

    // Not "Worked for 0s": a provider that states no time has stated no time.
    expect(screen.getByTestId('conversation-turn-process')).toHaveTextContent('Worked')
  })
})
