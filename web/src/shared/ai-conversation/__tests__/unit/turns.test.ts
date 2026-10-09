import { describe, expect, it } from 'vitest'
import { carryTurnKeys, isWorking, rememberTurns, runningWork, turnsOf } from '../../model/turns'
import type { AIConversationItem } from '../../model/conversation'
import {
  assistantMessage,
  statusItem,
  toolItem,
  unknownItem,
  userMessage,
} from '../fixtures/items'

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

  it('keeps an unmodelled row in the transcript without calling it work', () => {
    // This test used to assert the opposite — that an unmodelled row folds with
    // the work — and it was pinning a contradiction rather than a decision:
    // `isWork` says `unknown` is not work, while `process`, built by exclusion,
    // put it in the window anyway (#1363 round 4).
    //
    // `conversation.md`'s anatomy settles it. Its process window is "tool
    // activity rows, reasoning rows", and the rule that follows names the rows
    // that must *not* fold: "rows that are **not** the assistant's work". A
    // record we cannot model is not evidence of work — that is what `unknown`
    // means — so folding it under a control reading "Worked" would classify it
    // by the one thing the model refuses to guess.
    //
    // Where it goes instead is nowhere: not the answer, not the process, and
    // still in `items`, which is what preserves its order and keeps the row on
    // screen. `turnMembership` is what carries that to the renderer — an item
    // with no window is never hidden.
    const [turn] = turnsOf([
      userMessage('u1', 'q'),
      unknownItem('x1'),
      assistantMessage('a1', 'a'),
    ])

    expect(turn?.process).toEqual([])
    expect(turn?.answer?.id).toBe('a1')
  })

  it('does not let a notice the assistant did not produce extend “Worked for”', () => {
    // Two individually reasonable follow-ups met here: #1402 broadened the
    // duration to every timestamped item, and #1404 then added a canonical item
    // that is timestamped and explicitly *not* work. The label's verb decided
    // it — a notice ten minutes after the answer is not ten more minutes of
    // work, and the reader has no way to tell that from the number.
    const [turn] = turnsOf([
      { ...userMessage('u1', 'q'), timestamp: '2026-10-02T10:00:00.000Z' },
      { ...assistantMessage('a1', 'a'), timestamp: '2026-10-02T10:01:00.000Z' },
      {
        ...statusItem('s1', 'connection closed'),
        timestamp: '2026-10-02T10:10:00.000Z',
      } as AIConversationItem,
    ])

    expect(turn?.durationMs).toBe(60_000)
  })

  it('does not let an unmodelled row extend it either', () => {
    // The same line the fold draws. An `unknown` is not work, so it is not
    // minutes worked — the two readings have to agree or the label and the
    // window it opens are describing different turns.
    const [turn] = turnsOf([
      { ...userMessage('u1', 'q'), timestamp: '2026-10-02T10:00:00.000Z' },
      { ...assistantMessage('a1', 'a'), timestamp: '2026-10-02T10:01:00.000Z' },
      {
        ...unknownItem('x1'),
        timestamp: '2026-10-02T10:10:00.000Z',
      } as AIConversationItem,
    ])

    expect(turn?.durationMs).toBe(60_000)
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

/**
 * When a turn has finished, and it is not when the assistant last spoke.
 *
 * `#1363` round 3. The rule used to be "the last assistant message", which is
 * wrong in the case a live turn produces constantly: the assistant says
 * something and then goes back to work. Calling that message the answer ends
 * the turn, so the work still happening is drawn as finished.
 */
describe('the turn’s final answer', () => {
  it('is not a message the assistant went back to work after', () => {
    const [turn] = turnsOf([
      userMessage('u1', 'q'),
      assistantMessage('a1', 'working on it'),
      toolItem('t1', { status: 'running' }),
    ])

    expect(turn?.answer).toBeNull()
    // And the demoted message stays in the process window rather than vanishing:
    // it is progress, which is a thing the turn has, not a thing it lost.
    expect(turn?.process.map((item) => item.id)).toEqual(['a1', 't1'])
  })

  it('is still nothing when that work finishes with no answer after it', () => {
    // The tool settling does not promote the message it followed. Nothing was
    // answered, so inventing an answer would be the defect wearing a different
    // status.
    const [turn] = turnsOf([
      userMessage('u1', 'q'),
      assistantMessage('a1', 'working on it'),
      toolItem('t1', { status: 'success' }),
    ])

    expect(turn?.answer).toBeNull()
  })

  it('is the later message once the assistant answers after the work', () => {
    const [turn] = turnsOf([
      userMessage('u1', 'q'),
      assistantMessage('a1', 'working on it'),
      toolItem('t1', { status: 'success' }),
      assistantMessage('a2', 'done'),
    ])

    expect(turn?.answer?.id).toBe('a2')
    expect(turn?.process.map((item) => item.id)).toEqual(['a1', 't1'])
  })

  it('is not demoted by a trailing record the model does not name', () => {
    // `unknown` is not evidence that anything is still happening. Demoting on it
    // would end the turn for every provider that trails an unmodelled record,
    // which is the opposite of the fix.
    const [turn] = turnsOf([
      userMessage('u1', 'q'),
      assistantMessage('a1', 'done'),
      unknownItem('x1'),
    ])

    expect(turn?.answer?.id).toBe('a1')
  })
})

describe('runningWork', () => {
  it('reports work that has not finished, answer or not', () => {
    // The contradiction the review named: an answer *and* a tool still going.
    // The turn is not settled, and `workingOf` reads this to keep it open.
    const [turn] = turnsOf([
      userMessage('u1', 'q'),
      toolItem('t1', { status: 'running' }),
      assistantMessage('a1', 'done'),
    ])
    if (turn === undefined) {
      throw new Error('no turn')
    }

    expect(turn.answer?.id).toBe('a1')
    expect(runningWork(turn)).toBe(true)
  })

  it('is false when every work item has stopped', () => {
    const [turn] = turnsOf([
      userMessage('u1', 'q'),
      toolItem('t1'),
      assistantMessage('a1', 'done'),
    ])
    if (turn === undefined) {
      throw new Error('no turn')
    }

    expect(runningWork(turn)).toBe(false)
  })
})

describe('isWorking', () => {
  // The canonical phase, and the whole point of it is that there is one. Each
  // case here is a state the process disclosure and the turn's actions used to
  // answer independently, which let one frame say "still working" and "here is
  // the finished answer to copy" at the same time (#1363 round 4).
  const phaseOf = (...items: AIConversationItem[]) => {
    const [turn] = turnsOf(items)
    if (turn === undefined) {
      throw new Error('no turn')
    }
    return isWorking(turn)
  }

  it('is true with no answer at all', () => {
    // A question whose work has been folded is a hole, not a rest state.
    expect(phaseOf(userMessage('u1', 'q'), toolItem('t1'))).toBe(true)
  })

  it('is true while the answer is still streaming', () => {
    expect(
      phaseOf(userMessage('u1', 'q'), assistantMessage('a1', 'half', 'streaming')),
    ).toBe(true)
  })

  it('is true when the answer is in but the work is not', () => {
    expect(
      phaseOf(
        userMessage('u1', 'q'),
        toolItem('t1', { status: 'running' }),
        assistantMessage('a1', 'done so far'),
      ),
    ).toBe(true)
  })

  it('is false once the work has stopped and the answer is not streaming', () => {
    expect(
      phaseOf(userMessage('u1', 'q'), toolItem('t1'), assistantMessage('a1', 'done')),
    ).toBe(false)
  })

  it('is false for an answer with no status and no work', () => {
    // A provider that states nothing is believed: no status is not "streaming",
    // and a turn with a final answer and nothing running has settled. Guessing
    // otherwise would leave every such provider's last turn permanently open.
    expect(phaseOf(userMessage('u1', 'q'), assistantMessage('a1', 'done'))).toBe(false)
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
