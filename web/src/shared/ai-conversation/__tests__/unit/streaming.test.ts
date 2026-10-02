import { describe, expect, it } from 'vitest'
import { isStreaming } from '../../components/streaming'
import { assistantMessage, userMessage } from '../fixtures/items'

describe('isStreaming', () => {
  it('believes a status the provider stated, over what the page said', () => {
    // Both directions in one case, so the precedence itself is under test rather
    // than a single branch of it: a stated status decides whether or not the
    // page's own signal agrees with it.
    expect(isStreaming(assistantMessage('a', 'x', 'streaming'), true, false)).toBe(true)
    expect(isStreaming(assistantMessage('a', 'x', 'streaming'), false, false)).toBe(true)
    expect(isStreaming(assistantMessage('a', 'x', 'settled'), true, true)).toBe(false)
    expect(isStreaming(assistantMessage('a', 'x', 'interrupted'), true, true)).toBe(false)
  })

  it('falls back to the page when the provider states nothing about the message', () => {
    expect(isStreaming(assistantMessage('a', 'x'), true, true)).toBe(true)
    // Not the last row: something the provider considered complete follows it.
    expect(isStreaming(assistantMessage('a', 'x'), false, true)).toBe(false)
    // The page is not partial.
    expect(isStreaming(assistantMessage('a', 'x'), true, false)).toBe(false)
  })

  it('never calls the reader’s own message still arriving', () => {
    expect(isStreaming(userMessage('u', 'x'), true, true)).toBe(false)
  })
})
