import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ConversationTranscript } from '../../components/ConversationTranscript'
import { groupRows } from '../../model/grouping'
import { turnsOf } from '../../model/turns'
import type { AIConversationSnapshot } from '../../runtime/ConversationRuntime'
import {
  assistantMessage,
  reasoningItem,
  toolItem,
  userMessage,
} from '../fixtures/items'

/**
 * The `reasoning` arm of the model.
 *
 * It exists before any adapter emits it — a recorded exception to the model's
 * own "no speculative unions" rule, made because `#1363` names the hierarchy
 * `Turn → Process Group → Tool/Reasoning`. `activity.ts` carries the note; these
 * are the tests that keep an unused arm honest, which is the cost the note
 * names.
 */

function snapshot(items: AIConversationSnapshot['items']): AIConversationSnapshot {
  return {
    listState: 'ready',
    conversations: [],
    bindingId: 'c1',
    openId: 'c1',
    state: 'ready',
    conversation: null,
    activity: 'inactive',
    items,
    hasMore: false,
    partialTail: false,
    skipped: 0,
    listLoading: false,
    threadLoading: false,
    loadingOlder: false,
    olderError: null,
    listError: null,
    threadError: null,
  }
}

function renderTranscript(items: AIConversationSnapshot['items']) {
  return render(
    <ConversationTranscript
      snapshot={snapshot(items)}
      providerLabel="Claude"
      onLoadOlder={() => false}
    />,
  )
}

describe('reasoning as a process row', () => {
  it('belongs to the turn’s work, not to its opening or its answer', () => {
    const turn = turnsOf([
      userMessage('u1', 'q'),
      reasoningItem('r1'),
      toolItem('t1'),
      assistantMessage('a1', 'answer'),
    ])[0]

    // It folds with the work, which is the point of it being a process row.
    expect(turn?.process.map((item) => item.id)).toEqual(['r1', 't1'])
    expect(turn?.answer?.id).toBe('a1')
  })

  it('breaks a run of tool calls rather than joining it', () => {
    // The anatomy lists tool rows and reasoning rows as siblings. A group means
    // "consecutive tool calls", so a thought between two calls ends one group
    // and starts another instead of being swallowed into it.
    const rows = groupRows([toolItem('t1'), reasoningItem('r1'), toolItem('t2')])

    expect(rows.map((row) => row.kind)).toEqual(['item', 'item', 'item'])
    expect(rows.map((row) => row.key)).toEqual(['t1', 'r1', 't2'])
  })

  it('draws the provider’s own words, through the shared Markdown path', () => {
    renderTranscript([
      userMessage('u1', 'q'),
      reasoningItem('r1', 'The epoch is bumped in `attach`, not in the router.'),
      assistantMessage('a1', 'answer'),
    ])

    const body = screen.getByTestId('conversation-reasoning-body')
    expect(body).toHaveTextContent('The epoch is bumped in')
    expect(body.querySelector('code')).not.toBeNull()
  })

  it('says it is still thinking while it is', () => {
    renderTranscript([userMessage('u1', 'q'), reasoningItem('r1', 'weighing', 'running')])

    const row = screen.getByTestId('conversation-reasoning')
    expect(row).toHaveAttribute('data-status', 'running')
    expect(within(row).getByTestId('conversation-reasoning-running')).toBeDefined()
    expect(within(row).getByText('Thinking')).toBeDefined()
  })

  it('says it thought, in the past, once it has', () => {
    renderTranscript([userMessage('u1', 'q'), reasoningItem('r1', 'weighed', 'success')])

    const row = screen.getByTestId('conversation-reasoning')
    expect(within(row).getByText('Thought')).toBeDefined()
    expect(within(row).queryByTestId('conversation-reasoning-running')).toBeNull()
  })

  it('folds with the rest of the turn’s work', () => {
    // Which is what makes it a process row rather than a second kind of answer.
    renderTranscript([
      userMessage('u1', 'q'),
      reasoningItem('r1'),
      assistantMessage('a1', 'answer'),
    ])

    const row = screen
      .getByTestId('conversation-reasoning')
      .closest('[data-slot="message-scroller-item"]')
    expect(row).toHaveAttribute('hidden')
  })
})
