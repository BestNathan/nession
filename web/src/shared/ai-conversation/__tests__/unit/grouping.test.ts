import { describe, expect, it } from 'vitest'
import {
  carryGroupKeys,
  groupRows,
  rememberGroups,
  summarizeTools,
} from '../../model/grouping'
import { assistantMessage, toolItem, unknownItem, userMessage } from '../fixtures/items'

describe('groupRows', () => {
  it('groups a run of tool calls into one row', () => {
    const rows = groupRows([toolItem('t1'), toolItem('t2'), toolItem('t3')])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'tools', key: 'tools:t1' })
  })

  it('leaves a lone call as its own row', () => {
    // A disclosure that discloses one thing is a click for nothing, and it
    // would make a transcript that used one tool look busier than one that
    // used six.
    const rows = groupRows([toolItem('t1')])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'item' })
  })

  it('ends the run at anything that is not work', () => {
    const rows = groupRows([
      userMessage('u1', 'run it'),
      toolItem('t1'),
      toolItem('t2'),
      assistantMessage('a1', 'done'),
      toolItem('t3'),
      toolItem('t4'),
    ])

    expect(rows.map((row) => row.kind)).toEqual(['item', 'tools', 'item', 'tools'])
    // The assistant speaking between two calls is not work to be folded away.
    expect(rows[2]).toMatchObject({ kind: 'item' })
  })

  it('keeps a group’s key across an append', () => {
    const first = groupRows([toolItem('t1'), toolItem('t2')])
    const appended = groupRows([toolItem('t1'), toolItem('t2'), toolItem('t3')])

    // Anchored to the first item, so a group still being appended to keeps its
    // identity — otherwise every new call remounts it and the reader loses
    // their open disclosure mid-read.
    expect(appended[0]?.key).toBe(first[0]?.key)
  })

  it('keeps ungrouped rows in order and keyed by their own id', () => {
    const rows = groupRows([userMessage('u1', 'hi'), unknownItem('x1')])

    expect(rows.map((row) => row.key)).toEqual(['u1', 'x1'])
  })

  it('returns nothing for an empty transcript', () => {
    expect(groupRows([])).toEqual([])
  })
})

describe('summarizeTools', () => {
  it('counts by category, in a fixed order rather than first-seen', () => {
    const summary = summarizeTools([
      toolItem('a', { category: 'command' }),
      toolItem('b', { category: 'read' }),
      toolItem('c', { category: 'read' }),
    ])

    // A group whose calls arrive in another order — a transcript read
    // backwards, a provider reporting a subcall first — must not describe
    // itself differently.
    expect(summary.text).toBe('1 command · 2 file reads')
  })

  it('singularises a count of one', () => {
    expect(summarizeTools([toolItem('a', { category: 'search' })]).text).toBe('1 search')
  })

  it('treats an unclassified call as other rather than dropping it', () => {
    const summary = summarizeTools([
      toolItem('a'),
      toolItem('b', { category: 'read' }),
    ])

    expect(summary.text).toBe('1 file read · 1 action')
  })

  it('calls out failures and says nothing about success', () => {
    const summary = summarizeTools([
      toolItem('a', { status: 'success' }),
      toolItem('b', { status: 'error' }),
    ])

    // A row full of green ticks is noise that stops meaning anything; a
    // failure is the one thing a collapsed summary must not hide.
    expect(summary.failed).toBe(1)
    expect(summary.text).not.toContain('succe')
  })

  it('reports how much of the group is still running', () => {
    const summary = summarizeTools([
      toolItem('a', { status: 'running' }),
      toolItem('b', { status: 'running' }),
      toolItem('c', { status: 'success' }),
    ])

    expect(summary.running).toBe(2)
  })

  it('never lists tool names', () => {
    const summary = summarizeTools([
      toolItem('a', { name: 'Bash', category: 'command' }),
      toolItem('b', { name: 'Read', category: 'read' }),
    ])

    expect(summary.text).not.toContain('Bash')
    expect(summary.text).not.toContain('Read')
  })
})

describe('carrying a work group’s identity across a prepend', () => {
  it('keeps the key a group was rendered under when an older call joins it', () => {
    const remembered = new Map<string, string>()

    const before = carryGroupKeys(groupRows([toolItem('a'), toolItem('b')]), remembered)
    rememberGroups(before, remembered)
    expect(before[0]).toMatchObject({ key: 'tools:a' })

    // The run now starts at `x`; the derived key would be `tools:x`.
    const after = carryGroupKeys(
      groupRows([toolItem('x'), toolItem('a'), toolItem('b')]),
      remembered,
    )
    expect(after[0]).toMatchObject({ key: 'tools:a' })
  })

  it('leaves a genuinely new group on its derived key', () => {
    const remembered = new Map<string, string>([['a', 'tools:a']])

    const rows = carryGroupKeys(groupRows([toolItem('p'), toolItem('q')]), remembered)

    expect(rows[0]).toMatchObject({ key: 'tools:p' })
  })

  it('forgets ids that are no longer grouped', () => {
    const remembered = new Map<string, string>()
    rememberGroups(groupRows([toolItem('a'), toolItem('b')]), remembered)
    expect([...remembered.keys()]).toEqual(['a', 'b'])

    rememberGroups(groupRows([assistantMessage('m', 'done')]), remembered)

    // Otherwise the map grows with the conversation for as long as it is open.
    expect([...remembered.keys()]).toEqual([])
  })
})
