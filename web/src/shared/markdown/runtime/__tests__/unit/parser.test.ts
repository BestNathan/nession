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

    it.each([
      'Set $HOME and $PATH before running the build.',
      'echo "$VAR" prints the value of VAR.',
      'The cost is $100 and the other is $200.',
      'US$ 500 was spent, and it arrived in ~10ms.',
    ])('keeps single dollars as text, never maths: %s', (source) => {
      // #1184 decision 1: the Chat profile turns single-dollar text math off,
      // so coding-agent prose stays prose. A regression here re-swallows the
      // corpus between the two delimiters as a formula.
      const result = parseGfmWithMath(source)
      const paragraph = result.children[0] as Paragraph
      expect(paragraph.children.some((c) => c.type === 'inlineMath')).toBe(false)
    })

    it('keeps the $$ display delimiter working in text', () => {
      // Only the *single*-dollar form is off; $$ is the approved display
      // delimiter and must survive the option.
      const result = parseGfmWithMath('The identity $$x^2 + y^2 = z^2$$ holds.')
      const paragraph = result.children[0] as Paragraph
      expect(paragraph.children.some((c) => c.type === 'inlineMath')).toBe(true)
    })

    it('does not read dollar-side maths out of a currency range with a bare dollar', () => {
      const result = parseGfmWithMath('It costs $5.')
      const paragraph = result.children[0] as Paragraph
      expect(paragraph.children.some((c) => c.type === 'inlineMath')).toBe(false)
    })
  })

  describe('parseGfm (streaming grammar)', () => {
    it('never emits math nodes, so incomplete TeX stays literal mid-stream', () => {
      const result = parseGfm('The formula \\(E=mc^2\\) and $HOME stay literal.')
      const paragraph = result.children[0] as Paragraph
      expect(paragraph.children.some((c) => c.type === 'inlineMath')).toBe(false)
    })
  })
})
