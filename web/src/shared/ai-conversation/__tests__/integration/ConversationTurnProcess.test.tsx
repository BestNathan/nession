import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ConversationTranscript } from '../../components/ConversationTranscript'
import type { AIConversationSnapshot } from '../../runtime/ConversationRuntime'
import { assistantMessage, statusItem, toolItem, userMessage } from '../fixtures/items'

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

  it('measures the work when the provider timestamped only the work', () => {
    // The case the contract names and the implementation did not honour: a
    // provider that times its *tools* and leaves the participant messages
    // untimed. Both ends here are work, so a version reading timestamps through
    // the message narrowing reports `Worked` — true, but less than the data
    // supports.
    renderTranscript({
      items: [
        userMessage('u1', 'q'),
        { ...toolItem('t1'), timestamp: '2026-10-02T10:00:00.000Z' },
        { ...toolItem('t2'), timestamp: '2026-10-02T10:00:30.000Z' },
        assistantMessage('a1', 'a'),
      ],
    })

    expect(screen.getByTestId('conversation-turn-process')).toHaveTextContent('Worked for 30s')
  })

  it('draws a status notice without folding it into the work', () => {
    // #1363 SC-03: a provider's notice is a row of the transcript, not `unknown`
    // and not part of the assistant's work. The second half is the load-bearing
    // half — a notice that folded away with the process would vanish exactly
    // when a reader folds the work to look at the answer, which is when "why
    // there isn't one" matters most.
    renderTranscript({
      items: [
        userMessage('u1', 'q'),
        toolItem('t1'),
        toolItem('t2'),
        statusItem('s1', 'The host went away mid-turn'),
        assistantMessage('a1', 'a'),
      ],
    })

    // Settled, so the work is folded.
    expect(rowOf(screen.getByTestId('conversation-tool-group'))).toHaveAttribute('hidden')

    const notice = screen.getByTestId('conversation-status')
    expect(notice).toHaveTextContent('The host went away mid-turn')
    expect(rowOf(notice)).not.toHaveAttribute('hidden')
  })

  it('says only that it worked when the provider did not timestamp it', () => {
    renderTranscript({ items: [userMessage('u1', 'q'), toolItem('t1'), assistantMessage('a1', 'a')] })

    // Not "Worked for 0s": a provider that states no time has stated no time.
    expect(screen.getByTestId('conversation-turn-process')).toHaveTextContent('Worked')
  })
})

describe('transcript state across a conversation switch', () => {
  // Deliberately the same items and therefore the same ids in both
  // conversations, which is what makes this a test rather than a coincidence.
  const shared = [
    userMessage('u1', 'q'),
    toolItem('t1'),
    toolItem('t2'),
    assistantMessage('a1', 'done'),
  ]

  it('does not carry a disclosure the reader opened in another conversation', () => {
    // #1363 round 3. Every piece of transcript-local state is keyed by item,
    // turn and group ids, and those are unique only *within* a conversation —
    // so opening a second thread that reuses an id used to inherit the first
    // one's expansion, and the reader saw work already unfolded that they had
    // never opened here.
    const { rerender } = render(
      <ConversationTranscript
        snapshot={snapshot({ openId: 'c1', items: shared })}
        providerLabel="Claude"
        onLoadOlder={() => false}
      />,
    )

    fireEvent.click(screen.getByTestId('conversation-turn-process'))
    expect(rowOf(screen.getByTestId('conversation-tool-group'))).not.toHaveAttribute('hidden')

    rerender(
      <ConversationTranscript
        snapshot={snapshot({ openId: 'c2', items: shared })}
        providerLabel="Claude"
        onLoadOlder={() => false}
      />,
    )

    // Same ids, different conversation: folded again, because nobody opened it
    // here. Without the `key`, the override recorded under `t1` answers for this
    // render too.
    expect(rowOf(screen.getByTestId('conversation-tool-group'))).toHaveAttribute('hidden')
  })
})

describe('a turn the reader is inside when its answer settles', () => {
  const streaming = [
    userMessage('u1', 'the question'),
    toolItem('t1'),
    toolItem('t2'),
    assistantMessage('a1', 'writing…', 'streaming'),
  ]

  /** The same message, same id, now settled — the automatic fold. */
  const settled = [
    userMessage('u1', 'the question'),
    toolItem('t1'),
    toolItem('t2'),
    assistantMessage('a1', 'done', 'settled'),
  ]

  function draw(items: typeof streaming) {
    return render(
      <ConversationTranscript
        snapshot={snapshot({ items })}
        providerLabel="Claude"
        onLoadOlder={() => false}
      />,
    )
  }

  /** A control inside the work — what folding hides, and would strand focus in. */
  function innerControl(): HTMLElement {
    const summary = screen.getByTestId('conversation-tool-group').querySelector('summary')
    if (!(summary instanceof HTMLElement)) {
      throw new Error('the tool group has no summary to focus')
    }
    return summary
  }

  it('stays open rather than folding out from under the reader', () => {
    const { rerender } = draw(streaming)

    // Streaming, so the work is open without anyone having asked for it.
    expect(rowOf(screen.getByTestId('conversation-tool-group'))).not.toHaveAttribute('hidden')

    const inner = innerControl()
    inner.focus()
    expect(document.activeElement).toBe(inner)

    rerender(
      <ConversationTranscript
        snapshot={snapshot({ items: settled })}
        providerLabel="Claude"
        onLoadOlder={() => false}
      />,
    )

    // A system transition must not close what the reader is reading — and the
    // focus has to still be *in* it, not merely near it.
    expect(rowOf(screen.getByTestId('conversation-tool-group'))).not.toHaveAttribute('hidden')
    expect(document.activeElement).toBe(inner)
  })

  it('keeps a turn open while its work is still running, answer or not', () => {
    // #1363 round 3, the contradiction it named: the assistant answered *and* a
    // tool it started is still going. An answer alone would settle the turn and
    // fold away the only thing still moving, so liveness reads the canonical
    // work items rather than only what the provider said about the message.
    renderTranscript({
      items: [
        userMessage('u1', 'q'),
        toolItem('t1', { status: 'running' }),
        toolItem('t2', { status: 'running' }),
        assistantMessage('a1', 'started it'),
      ],
    })

    expect(rowOf(screen.getByTestId('conversation-tool-group'))).not.toHaveAttribute('hidden')
  })

  it('still folds a settled turn nobody is inside', () => {
    // The guard on the rule above. A pin that fired for every turn would pass
    // that test and quietly delete the folding feature, so the ordinary case is
    // asserted beside it.
    const { rerender } = draw(streaming)

    rerender(
      <ConversationTranscript
        snapshot={snapshot({ items: settled })}
        providerLabel="Claude"
        onLoadOlder={() => false}
      />,
    )

    expect(rowOf(screen.getByTestId('conversation-tool-group'))).toHaveAttribute('hidden')
  })
})
