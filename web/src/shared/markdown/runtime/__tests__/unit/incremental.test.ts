/**
 * The incremental parser's own invariants (#1184 SC-04…SC-06, SC-11, SC-13).
 *
 * The parser is an optimization over "parse the whole accumulated text every
 * frame". These tests hold it to the two things that optimization must never
 * trade away — the frozen prefix stays equivalent to a fresh parse of the same
 * source, and per-update work tracks the unstable tail rather than the whole
 * reply — plus the two lifecycle guarantees callers depend on: a block's key
 * survives the freeze transition, and non-append input resets cleanly.
 */

import { describe, it, expect } from 'vitest'
import type { Code } from 'mdast'
import { IncrementalMarkdownParser, type PositionedBlock } from '../../incremental'
import { parseGfm } from '../../parser'
import { allCases } from '../../../__tests__/fixtures/markdownCorpus'

/**
 * A node with positions stripped: every field a renderer reads, and nothing
 * about where the source happened to sit. Positions are the one thing the
 * incremental parse cannot compare directly — a frozen block's are relative to
 * the slice it was parsed from — so they are normalized away here while the
 * identity they carry (the absolute start offset) is asserted separately as
 * the block key.
 *
 * The comparison is deliberately the *whole* subtree, not a text projection:
 * heading depth, a link's url and title, a reference identifier, a code
 * fence's lang and meta, a list's ordered/start/spread/checked, a table's
 * alignment and every other semantic field are exactly where a divergence can
 * hide while the visible text stays identical (#1184 round-2 review).
 */
function withoutPositions(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(withoutPositions)}
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'position')
        .map(([key, child]) => [key, withoutPositions(child)]),
    )
  }
  return value
}

/** The full semantic tree of a block list, each block keyed by its source offset. */
function semanticSignature(blocks: readonly PositionedBlock[]): unknown {
  return blocks.map((block) => ({ key: block.key, node: withoutPositions(block.node) }))
}

/** The same signature a one-shot parse of the source produces. */
function freshSemanticSignature(text: string): unknown {
  return parseGfm(text).children.map((node, index) => ({
    key: node.position?.start.offset ?? -(index + 1),
    node: withoutPositions(node),
  }))
}

/** A grammar that records how many characters each update made it parse. */
function countingGrammar(): { parse: (text: string) => ReturnType<typeof parseGfm>; lengths: number[] } {
  const lengths: number[] = []
  return {
    parse: (text: string) => {
      lengths.push(text.length)
      return parseGfm(text)
    },
    lengths,
  }
}

/** A document long enough that a full re-parse per chunk would be visible. */
const LONG_DOCUMENT = Array.from(
  { length: 40 },
  (_, index) => `Paragraph ${index} with **bold** and \`code\` text that runs long enough to matter.`,
).join('\n\n')

describe('IncrementalMarkdownParser', () => {
  describe('incremental ≈ fresh (#1184 SC-13)', () => {
    for (const chunkSize of [1, 3, 7, 16]) {
      it(`matches a fresh parse at every prefix with chunk size ${chunkSize}`, () => {
        for (const testCase of allCases) {
          if (testCase.markdown.trim() === '') {continue}
          const parser = new IncrementalMarkdownParser(parseGfm)
          for (let end = chunkSize; end < testCase.markdown.length; end += chunkSize) {
            const text = testCase.markdown.slice(0, end)
            const { frozen, tail } = parser.update(text)
            expect(semanticSignature([...frozen, ...tail]), `${testCase.name} @ ${end}`)
              .toEqual(freshSemanticSignature(text))
          }
        }
      })
    }
  })

  describe('per-update work tracks the tail (#1184 SC-04)', () => {
    it('parses far fewer characters than the full-reparse baseline', () => {
      const { parse, lengths } = countingGrammar()
      const parser = new IncrementalMarkdownParser(parse)
      let naiveWork = 0
      for (let end = 10; end <= LONG_DOCUMENT.length; end += 10) {
        const text = LONG_DOCUMENT.slice(0, end)
        naiveWork += text.length
        parser.update(text)
      }
      const actualWork = lengths.reduce((total, length) => total + length, 0)
      // The frozen prefix is parsed once, the tail parses and re-parses.
      // Anything approaching the naive total means the freeze stopped working.
      expect(actualWork).toBeLessThan(naiveWork / 3)
    })

    it('returns the previous result for identical input', () => {
      const { parse, lengths } = countingGrammar()
      const parser = new IncrementalMarkdownParser(parse)
      const first = parser.update(LONG_DOCUMENT.slice(0, 500))
      const calls = lengths.length
      const second = parser.update(LONG_DOCUMENT.slice(0, 500))
      expect(second).toBe(first)
      expect(lengths.length).toBe(calls)
    })
  })

  describe('open fences (#1184 SC-11)', () => {
    it('accumulates an open fence and re-parses only its pending tail', () => {
      const { parse, lengths } = countingGrammar()
      const parser = new IncrementalMarkdownParser(parse)
      let text = '```ts\n'
      parser.update(text)
      const expectedLines: string[] = []
      for (let index = 0; index < 200; index += 1) {
        const line = `const value${index} = ${index}\n`
        expectedLines.push(line)
        text += line
        parser.update(text)
      }
      const { frozen, tail } = parser.update(text)
      const blocks = [...frozen, ...tail]
      const last = blocks[blocks.length - 1]
      expect(last?.node.type).toBe('code')
      // The code block's value is the full accumulated content, exactly what a
      // one-shot parse of the same source produces.
      const freshChildren = parseGfm(text).children
      const fresh = freshChildren[freshChildren.length - 1] as Code
      expect((last?.node as Code).value).toBe(fresh.value)
      // mdast strips the line ending at end of input, so the accumulated
      // content compares without the final newline.
      expect((last?.node as Code).value).toBe(expectedLines.join('').replace(/\n$/, ''))
      // After the opening parse, no update hands the grammar more than the
      // current partial line plus the synthetic opening — never the fence.
      const settledWork = lengths.slice(3)
      expect(settledWork.length).toBeGreaterThan(100)
      expect(Math.max(...settledWork)).toBeLessThan(100)
    })
  })

  describe('block identity across the freeze boundary (#1184 SC-05)', () => {
    it('keeps a block key stable from first appearance through freezing', () => {
      const parser = new IncrementalMarkdownParser(parseGfm)
      const document = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.'
      const keys: number[] = []
      let frozenFirst: PositionedBlock | undefined
      for (let end = 4; end <= document.length; end += 4) {
        const { frozen, tail } = parser.update(document.slice(0, end))
        const first = [...frozen, ...tail][0]
        if (first !== undefined) {keys.push(first.key)}
        if (frozen.length > 0) {frozenFirst = frozen[0]}
      }
      expect(new Set(keys)).toEqual(new Set([0]))
      expect(frozenFirst?.node.type).toBe('heading')
      expect(frozenFirst?.key).toBe(0)
    })
  })

  describe('non-append input resets (#1184 SC-06)', () => {
    it('bumps the generation and rebuilds the prefix from the new text', () => {
      const parser = new IncrementalMarkdownParser(parseGfm)
      const first = parser.update('# A\n\np1\n\np2\n\np3')
      expect(first.generation).toBe(0)
      expect(first.frozen.length).toBeGreaterThan(0)

      const replaced = parser.update('# B\n\nq1\n\nq2\n\nq3')
      expect(replaced.generation).toBe(1)
      expect(semanticSignature([...replaced.frozen, ...replaced.tail]))
        .toEqual(freshSemanticSignature('# B\n\nq1\n\nq2\n\nq3'))

      // A third, unrelated rewrite bumps again — reset is not a one-off.
      const again = parser.update('Entirely different ending.')
      expect(again.generation).toBe(2)
      expect(semanticSignature([...again.frozen, ...again.tail]))
        .toEqual(freshSemanticSignature('Entirely different ending.'))
    })

    it('does not bump the generation for an append', () => {
      const parser = new IncrementalMarkdownParser(parseGfm)
      parser.update('# A\n\np1')
      const grown = parser.update('# A\n\np1\n\np2')
      expect(grown.generation).toBe(0)
    })
  })
})
