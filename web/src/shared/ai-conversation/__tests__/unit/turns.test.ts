import { describe, expect, it } from 'vitest'
import { turnsOf } from '../../model/turns'
import { assistantMessage, toolItem, unknownItem, userMessage } from '../fixtures/items'

const ids = (items: { id: string }[]) => items.map((item) => item.id)

describe('turnsOf', () => {
  it('opens at the user’s message and answers with the assistant’s last one', () => {
    const turns = turnsOf([
      userMessage('u1', 'do the thing'),
      toolItem('t1'),
      toolItem('t2'),
      assistantMessage('a1', 'done'),
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0]?.key).toBe('u1')
    expect(turns[0]?.opening?.id).toBe('u1')
    expect(turns[0]?.answer?.id).toBe('a1')
    // The work is what folds — not the question, and not the answer.
    expect(ids(turns[0]?.process ?? [])).toEqual(['t1', 't2'])
  })

  it('treats an earlier assistant message as progress, not as a second answer', () => {
    const turns = turnsOf([
      userMessage('u1', 'do the thing'),
      assistantMessage('a1', 'let me look'),
      toolItem('t1'),
      assistantMessage('a2', 'done'),
    ])

    // "Intermediate assistant progress" sits inside the process window; a turn
    // with three assistant messages still has one answer.
    expect(turns[0]?.answer?.id).toBe('a2')
    expect(ids(turns[0]?.process ?? [])).toEqual(['a1', 't1'])
  })

  it('keys a turn that does not open with a user message by what it starts with', () => {
    // Reading backwards from the middle of a conversation: there is no question
    // above the oldest item, and that is not an opening to invent.
    const turns = turnsOf([toolItem('t1'), assistantMessage('a1', 'done')])

    expect(turns).toHaveLength(1)
    expect(turns[0]?.key).toBe('t1')
    expect(turns[0]?.opening).toBeNull()
    expect(ids(turns[0]?.process ?? [])).toEqual(['t1'])
  })

  it('starts a new turn at each user message', () => {
    const turns = turnsOf([
      userMessage('u1', 'first'),
      assistantMessage('a1', 'one'),
      userMessage('u2', 'second'),
      toolItem('t1'),
      assistantMessage('a2', 'two'),
    ])

    expect(turns.map((turn) => turn.key)).toEqual(['u1', 'u2'])
    expect(turns[0]?.process).toEqual([])
    expect(ids(turns[1]?.process ?? [])).toEqual(['t1'])
  })

  it('keeps a provider’s unmodelled rows in the process window', () => {
    // Not the answer, not the question — so it folds with the work rather than
    // being dropped or promoted.
    const turns = turnsOf([userMessage('u1', 'q'), unknownItem('x1'), assistantMessage('a1', 'a')])

    expect(ids(turns[0]?.process ?? [])).toEqual(['x1'])
  })

  it('measures a duration only from timestamps the provider stated', () => {
    const timed = turnsOf([
      { ...userMessage('u1', 'q'), timestamp: '2026-10-02T10:00:00.000Z' },
      { ...assistantMessage('a1', 'a'), timestamp: '2026-10-02T10:00:12.000Z' },
    ])
    expect(timed[0]?.durationMs).toBe(12_000)

    // Arrival time is the reader's connection, not the assistant's work.
    const untimed = turnsOf([userMessage('u1', 'q'), assistantMessage('a1', 'a')])
    expect(untimed[0]?.durationMs).toBeNull()

    // One end is not a span.
    const half = turnsOf([
      { ...userMessage('u1', 'q'), timestamp: '2026-10-02T10:00:00.000Z' },
      assistantMessage('a1', 'a'),
    ])
    expect(half[0]?.durationMs).toBeNull()
  })

  it('has no turns for an empty transcript', () => {
    expect(turnsOf([])).toEqual([])
  })
})
