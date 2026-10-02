import { describe, expect, it } from 'vitest'
import { carryTurnKeys, rememberTurns, turnsOf } from '../../model/turns'
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

describe('carrying turn identity across a prepend', () => {
  /** The window a conversation read backwards from the middle actually opens. */
  const midTurn = [
    userMessage('u0', 'the question'),
    toolItem('t1'),
    toolItem('t2'),
    assistantMessage('a1', 'the answer'),
  ]

  it('keys a mid-turn window by the first item it has', () => {
    // The baseline the carry is measured against: without the opener, the turn
    // is keyed by the tool call it happens to start with.
    const without = turnsOf(midTurn.slice(1))
    expect(without.map((turn) => turn.key)).toEqual(['t1'])
  })

  it('keeps that key when an older page reveals the opener', () => {
    const remembered = new Map<string, string>()
    const before = carryTurnKeys(turnsOf(midTurn.slice(1)), remembered)
    rememberTurns(before, remembered)

    const after = carryTurnKeys(turnsOf(midTurn), remembered)

    // The key the reader's expansion was recorded under, not the opener's id.
    expect(after.map((turn) => turn.key)).toEqual(['t1'])
    // And the turn really did gain its opening — otherwise this would pass by
    // the prepend having done nothing.
    expect(after[0]?.opening?.id).toBe('u0')
  })

  it('leaves a turn the renderer has never seen at its own key', () => {
    const remembered = new Map<string, string>()
    rememberTurns(carryTurnKeys(turnsOf(midTurn.slice(1)), remembered), remembered)

    // A genuinely new turn appends at the end; it has no history to carry, so
    // inventing one would be worse than the derived key.
    const after = carryTurnKeys(
      turnsOf([...midTurn, userMessage('u2', 'next'), assistantMessage('a2', 'again')]),
      remembered,
    )

    expect(after.map((turn) => turn.key)).toEqual(['t1', 'u2'])
  })

  it('forgets ids that are no longer in any turn', () => {
    const remembered = new Map<string, string>()
    rememberTurns(carryTurnKeys(turnsOf(midTurn), remembered), remembered)
    expect([...remembered.keys()].sort()).toEqual(['a1', 't1', 't2', 'u0'])

    const shrunk = new Map(remembered)
    rememberTurns(carryTurnKeys(turnsOf([assistantMessage('a1', 'the answer')]), shrunk), shrunk)

    // Otherwise the map grows with the conversation rather than with the screen.
    expect([...shrunk.keys()]).toEqual(['a1'])
  })
})
