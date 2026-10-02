/**
 * The markdown renderer's two mdast grammars, one per rendering arm. Each
 * arm is internally consistent — the incremental tail parses, the one-shot
 * parses, and the plain-text projection of a given grammar always agree on
 * where blocks start and end — and the settled grammar is the streaming one
 * plus the math extensions, so the arms differ only where TeX delimiters
 * begin a math construct (a `$$` block is a paragraph while streaming and a
 * math block once settled, by design).
 *
 * Upstream: https://github.com/deepseek-ai/deepseek-harness
 * Baseline: 21638c56315ae6a2b552d6091945d3144c9af32e
 * Source: packages/client/ui-primitives/src/markdown/parse.ts
 * License: MIT (see THIRD_PARTY_NOTICES.md)
 * Adaptation: Adopted, then tuned for the Nession Chat dialect: GFM's
 * optional single-tilde strikethrough is off (SC-09) and single-dollar text
 * math is off (decision 1) so `~10ms`, `60~70%`, `$HOME` and `$100` stay
 * prose. Document Markdown keeps the default grammar.
 */

import type { Root } from 'mdast'
import { recoverLocalImages } from './local-image-syntax.ts'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import { cjkFriendlyStrong } from './cjkFriendlyStrong.ts'
import { mathCompatibility } from './mathCompatibility.ts'

/**
 * Parse GFM markdown (the streaming arm's grammar: no math, so incomplete
 * TeX never flashes KaTeX errors mid-stream).
 *
 * Strikethrough requires the explicit `~~` (`#1184` SC-09): GFM's optional
 * single tilde would strike through the middle of `~10ms, and 60~70%` and
 * every other approximation or range in coding-agent prose. The Document
 * profile is not bound by this — it keeps the default grammar.
 * @param text - Markdown source.
 * @returns The mdast root.
 */
export function parseGfm(text: string): Root {
  return recoverLocalImages(fromMarkdown(text, {
    extensions: [gfm({ singleTilde: false }), cjkFriendlyStrong()],
    mdastExtensions: [gfmFromMarkdown()],
  }), text)
}

/**
 * Parse GFM markdown plus TeX math with the compatibility delimiters
 * (the settled arm's grammar).
 *
 * Single-dollar text math is off (`#1184` decision 1): in coding-agent prose
 * `$HOME`, `$PATH`, `$100 ... $200` and `echo "$VAR"` are text, not formulae,
 * so `$...$` never opens an inline formula here. Inline math uses `\(...\)`
 * and display math uses `\[...\]` or `$$...$$`.
 * @param text - Markdown source.
 * @returns The mdast root.
 */
export function parseGfmWithMath(text: string): Root {
  return recoverLocalImages(fromMarkdown(text, {
    extensions: [
      gfm({ singleTilde: false }),
      cjkFriendlyStrong(),
      mathCompatibility(),
      math({ singleDollarTextMath: false }),
    ],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  }), text)
}
