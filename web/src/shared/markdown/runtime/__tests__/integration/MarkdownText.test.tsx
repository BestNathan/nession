/**
 * The Chat Markdown lifecycle: what survives a streamed message growing,
 * freezing, settling and being rewritten (#1184 SC-04…SC-06, SC-13, SC-14).
 *
 * The unit tests hold the parser to these invariants; these hold the rendered
 * document to them, where the promise is concrete — a block that has been on
 * screen does not blink out of existence because it froze, and a reference the
 * settled document defines resolves even when streaming had to leave it
 * literal.
 */

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ChatMarkdown } from '../../../ChatMarkdown'

describe('Chat Markdown lifecycle', () => {
  describe('frozen block identity (#1184 SC-05)', () => {
    it('keeps the DOM nodes of blocks that cross the freeze boundary', () => {
      const stage1 = '# Title\n\nFirst paragraph.'
      const stage2 = `${stage1}\n\nSecond paragraph.\n\nThird paragraph.`
      const stage3 = `${stage2}\n\nFourth paragraph.\n\nFifth paragraph.`
      const { container, rerender } = render(<ChatMarkdown text={stage1} streaming />)

      const heading = container.querySelector('h2')
      const firstParagraph = container.querySelector('p')
      expect(heading).not.toBeNull()
      expect(firstParagraph).not.toBeNull()

      // At stage 2 the first two blocks freeze; at stage 3 the second and
      // third do — and the second paragraph's position in the frozen prefix
      // differs from its position in the tail it just left. A key that came
      // from the list index rather than the source offset moves with it and
      // remounts it here; a source offset does not.
      rerender(<ChatMarkdown text={stage2} streaming />)
      expect(container.querySelector('h2')).toBe(heading)
      expect(container.querySelector('p')).toBe(firstParagraph)
      const secondParagraph = container.querySelectorAll('p')[1]
      expect(secondParagraph).not.toBeUndefined()

      rerender(<ChatMarkdown text={stage3} streaming />)
      expect(container.querySelector('h2')).toBe(heading)
      expect(container.querySelector('p')).toBe(firstParagraph)
      expect(container.querySelectorAll('p')[1]).toBe(secondParagraph)
    })

    it('keeps the DOM nodes when a streamed message settles', () => {
      const text = '# Title\n\nFirst paragraph.'
      const { container, rerender } = render(<ChatMarkdown text={text} streaming />)

      const heading = container.querySelector('h2')
      // The settled full parse is authoritative, but it is not a remount: the
      // same source offsets key the same blocks.
      rerender(<ChatMarkdown text={text} />)
      expect(container.querySelector('h2')).toBe(heading)
    })
  })

  describe('non-append rewrite (#1184 SC-06)', () => {
    it('replaces the whole rendered document', () => {
      const { container, rerender } = render(<ChatMarkdown text={'# Original\n\nBody.'} streaming />)
      expect(container.textContent).toContain('Original')

      rerender(<ChatMarkdown text={'# Rewritten\n\nNew body.'} streaming />)
      expect(container.textContent).toContain('Rewritten')
      expect(container.textContent).not.toContain('Original')
    })
  })

  describe('settled self-heal (#1184 SC-14)', () => {
    it('resolves a reference whose definition arrives after the block froze', () => {
      const base = 'See [the notes][n].\n\npara\n\npara2\n\npara3'
      const withDefinition = `${base}\n\n[n]: https://example.com/notes`
      const { container, rerender } = render(<ChatMarkdown text={base} streaming />)

      expect(container.querySelector('a')).not.toBeInTheDocument()
      expect(container.textContent).toContain('[the notes][n]')

      // The definition lands after the reference froze: streaming keeps the
      // literal text — the documented degradation — and does not pretend.
      rerender(<ChatMarkdown text={withDefinition} streaming />)
      expect(container.querySelector('a')).not.toBeInTheDocument()
      expect(container.textContent).toContain('[the notes][n]')

      // Settling re-parses the whole message, which is the canonical result.
      rerender(<ChatMarkdown text={withDefinition} />)
      const anchor = container.querySelector('a[href="https://example.com/notes"]')
      expect(anchor).toBeInTheDocument()
      expect(anchor).toHaveTextContent('the notes')
    })

    it('resolves a footnote whose definition arrives after the block froze', () => {
      const base = 'The observer path has no test.[^observer]\n\npara\n\npara2\n\npara3'
      const withDefinition = `${base}\n\n[^observer]: Only the attach path is covered.`
      const { container, rerender } = render(<ChatMarkdown text={base} streaming />)

      expect(container.textContent).toContain('[^observer]')
      expect(container.querySelector('[data-footnotes]')).not.toBeInTheDocument()

      rerender(<ChatMarkdown text={withDefinition} streaming />)
      expect(container.textContent).toContain('[^observer]')

      rerender(<ChatMarkdown text={withDefinition} />)
      expect(container.querySelector('sup a')).toHaveTextContent('[1]')
      expect(container.querySelector('[data-footnotes]')).toHaveTextContent('Only the attach path is covered.')
    })
  })

  describe('streaming footnote state (#1184 SC-14)', () => {
    it('numbers footnotes in first-reference order across the freeze boundary', () => {
      const text = 'First.[^a]\n\n[^a]: A body.\n\nSecond.[^b]\n\n[^b]: B body.'
      const { container } = render(<ChatMarkdown text={text} streaming />)

      const numbers = [...container.querySelectorAll('sup a')].map((element) => element.textContent)
      expect(numbers).toEqual(['[1]', '[2]'])
      const section = container.querySelector('[data-footnotes]')
      expect(section).toHaveTextContent('A body.')
      expect(section).toHaveTextContent('B body.')
    })

    it('links each reference to its section entry', () => {
      const text = 'First.[^a]\n\n[^a]: A body.'
      const { container } = render(<ChatMarkdown text={text} />)

      const reference = container.querySelector('sup a')
      const entry = container.querySelector('[data-footnotes] li')
      expect(reference).toHaveAttribute('href', `#${entry?.id}`)
      expect(container.querySelector('[data-footnotes] li a')).toHaveAttribute('href', '#fnref-1')
    })
  })
})
