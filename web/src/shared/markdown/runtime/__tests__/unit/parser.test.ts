import { describe, it, expect } from 'vitest'
import type { Paragraph, RootContent } from 'mdast'
import { parseGfm, parseGfmWithMath } from '../../parser'

describe('parser', () => {
  describe('parseGfm', () => {
    it('parses a simple paragraph', () => {
      const result = parseGfm('Hello, world!')
      expect(result.type).toBe('root')
      expect(result.children).toHaveLength(1)
      expect(result.children[0].type).toBe('paragraph')
    })

    it('parses headings', () => {
      const result = parseGfm('# Heading 1\n\n## Heading 2')
      expect(result.children).toHaveLength(2)
      expect(result.children[0].type).toBe('heading')
      expect(result.children[1].type).toBe('heading')
    })

    it('parses code blocks', () => {
      const result = parseGfm('```javascript\nconsole.log("hello")\n```')
      expect(result.children).toHaveLength(1)
      expect(result.children[0].type).toBe('code')
    })

    it('parses lists', () => {
      const result = parseGfm('- Item 1\n- Item 2\n- Item 3')
      expect(result.children).toHaveLength(1)
      expect(result.children[0].type).toBe('list')
    })

    it('parses links', () => {
      const result = parseGfm('[Example](https://example.com)')
      expect(result.children).toHaveLength(1)
      expect(result.children[0].type).toBe('paragraph')
      const paragraph = result.children[0] as Paragraph
      expect(paragraph.children[0].type).toBe('link')
    })

    it('parses emphasis', () => {
      const result = parseGfm('*italic* and **bold**')
      expect(result.children).toHaveLength(1)
      const paragraph = result.children[0] as Paragraph
      expect(paragraph.children[0].type).toBe('emphasis')
      expect(paragraph.children[2].type).toBe('strong')
    })
  })

  describe('parseGfmWithMath', () => {
    it('parses inline math with \\(\\)', () => {
      const result = parseGfmWithMath('The formula \\(E=mc^2\\) is famous.')
      expect(result.children).toHaveLength(1)
      const paragraph = result.children[0] as Paragraph
      expect(paragraph.children.some((c) => c.type === 'inlineMath')).toBe(true)
    })

    it('parses display math with \\[\\]', () => {
      const result = parseGfmWithMath('The equation:\n\n\\[x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\\]')
      expect(result.children.some((c: RootContent) => c.type === 'math')).toBe(true)
    })

    it('parses display math with $$', () => {
      const result = parseGfmWithMath('$$\nx^2 + y^2 = z^2\n$$')
      expect(result.children.some((c: RootContent) => c.type === 'math')).toBe(true)
    })

    it('currently parses single $ as math (known gap - will be disabled in Phase 2)', () => {
      // The vendored DeepSeek parser supports single $ for inline math via math() extension.
      // Requirement #1184 specifies single $ should NOT be math to avoid false positives
      // like $HOME, $PATH, $100. This will be addressed in Phase 2 by configuring the
      // parser to only support \(\) for inline and \[\] / $$ for display math.
      const result = parseGfmWithMath('The cost is $100 and $HOME is set.')
      const paragraph = result.children[0] as Paragraph
      // Check if any inline child is inlineMath (math nodes can't appear in paragraphs)
      const hasMath = paragraph.children.some((c) => c.type === 'inlineMath')
      expect(hasMath).toBe(true) // Currently true, will be false after Phase 2
    })
  })
})
