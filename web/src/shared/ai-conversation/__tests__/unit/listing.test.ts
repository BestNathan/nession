import { describe, expect, it } from 'vitest'
import {
  bucketOf,
  bucketRows,
  conversationLabel,
  previewLine,
  undatedRows,
} from '../../model/listing'
import type { AIConversationSummary } from '../../model/conversation'

function summary(overrides: Partial<AIConversationSummary> = {}): AIConversationSummary {
  return { id: 'c1', activity: 'unknown', ...overrides }
}

/** A fixed clock, so the boundary assertions stand *on* the boundary. */
const NOW = new Date('2026-10-01T09:00:00')

describe('bucketOf', () => {
  it('puts today on the calendar day, not in a rolling 24 hours', () => {
    // 20:00 yesterday is *yesterday* to a person, and would be "today" to a
    // rolling window — which is the difference this asserts.
    expect(bucketOf('2026-10-01T08:00:00', NOW)).toBe('today')
    expect(bucketOf('2026-09-30T20:00:00', NOW)).toBe('previous-7-days')
  })

  it('includes a timestamp exactly seven days old', () => {
    expect(bucketOf('2026-09-24T09:00:00', NOW)).toBe('previous-7-days')
    expect(bucketOf('2026-09-23T09:00:00', NOW)).toBe('older')
  })

  it('answers null rather than filing an unknown date under older', () => {
    // No timestamp is not evidence of age, and `older` would assert a fact
    // nothing knows.
    expect(bucketOf(null, NOW)).toBeNull()
    expect(bucketOf(undefined, NOW)).toBeNull()
    expect(bucketOf('not a date', NOW)).toBeNull()
  })
})

describe('conversationLabel', () => {
  it('uses a title verbatim', () => {
    // Providers return titles untruncated and in their own language; shortening
    // belongs to the element that knows its width.
    expect(conversationLabel(summary({ title: '底板反向条件分支' }))).toBe('底板反向条件分支')
    expect(conversationLabel(summary({ title: '  spaced  ' }))).toBe('spaced')
  })

  it('falls back to the date, and never returns an empty string', () => {
    const label = conversationLabel(summary({ updatedAt: '2026-10-01T10:06:00Z' }), 'en-US')
    expect(label).toContain('Conversation ·')
    expect(conversationLabel(summary())).toBe('Conversation')
    expect(conversationLabel(summary({ title: '   ' }))).toBe('Conversation')
  })
})

describe('previewLine', () => {
  it('collapses a multi-line prompt into one line', () => {
    expect(previewLine('fix this\n\nplease')).toBe('fix this please')
  })

  it('answers null for whitespace, so the row does not reserve a blank line', () => {
    expect(previewLine('   \n  ')).toBeNull()
    expect(previewLine(null)).toBeNull()
    expect(previewLine('')).toBeNull()
  })

  it('keeps a slash command intact', () => {
    expect(previewLine('/compact')).toBe('/compact')
  })
})

describe('bucketRows and undatedRows', () => {
  const conversations = [
    summary({ id: 'today', updatedAt: '2026-10-01T08:00:00' }),
    summary({ id: 'old', updatedAt: '2026-01-01T08:00:00' }),
    summary({ id: 'undated' }),
  ]

  it('orders buckets and omits empty ones', () => {
    const buckets = bucketRows(conversations, NOW)

    expect(buckets.map((entry) => entry.bucket)).toEqual(['today', 'older'])
    expect(buckets[0]?.rows.map((row) => row.id)).toEqual(['today'])
  })

  it('separates the undated ones so the caller can render them unheaded', () => {
    expect(undatedRows(conversations, NOW).map((row) => row.id)).toEqual(['undated'])
  })

  it('carries what a row draws', () => {
    const [row] = bucketRows(
      [summary({ id: 'c1', title: 'A title', preview: 'do\nit', updatedAt: '2026-10-01T08:00:00' })],
      NOW,
    )[0]?.rows ?? []

    expect(row).toMatchObject({ id: 'c1', label: 'A title', preview: 'do it' })
    expect(row?.time).toBeTruthy()
  })
})
