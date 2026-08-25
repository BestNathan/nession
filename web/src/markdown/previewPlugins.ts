import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { PluggableList } from 'unified';
import type { Literal } from 'mdast';
import type { Options as RemarkRehypeOptions } from 'remark-rehype';
import { FRONTMATTER_TABLE_CLASS, frontmatterToHast } from './frontmatterTable';

/**
 * The remark/rehype plugin chain used to render markdown previews.
 *
 * Kept here rather than inline in the component so the pipeline is testable on
 * its own and every preview surface renders identically.
 */

/**
 * Sanitize schema for markdown previews.
 *
 * Extends the default GitHub-style schema so the raw markdown HTML can be
 * sanitized *before* KaTeX and highlight.js run (they generate trusted HTML of
 * their own afterwards). remark-math marks math spans with
 * `math-inline` / `math-display` on `<code>`, so those class names must survive
 * the sanitize pass for rehype-katex to pick them up.
 *
 * Two additions exist for the frontmatter panel, both kept as tight as possible:
 *
 * - `table` may carry `className`, but **only** the exact frontmatter class.
 *   This is the same value-restricted form the default schema uses for
 *   `task-list-item` and `language-*`. Measured: raw HTML in a document is
 *   dropped wholesale by this chain (there is no rehype-raw, so `raw` nodes never
 *   become elements — a `<table class="…">` in markdown renders as nothing at
 *   all), so no document can reach this attribute today. The restriction is
 *   therefore defence in depth against a future change that adds raw-HTML
 *   support, not a fix for a live hole: an unrestricted `className` on `table`
 *   would then let any file apply arbitrary utility classes.
 * - `caption` is added to `tagNames`; the default schema omits it. It is inert —
 *   valid only inside a table and allowed no attributes of its own.
 */
export const markdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'caption'],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    table: [['className', FRONTMATTER_TABLE_CLASS]],
  },
};

/**
 * Frontmatter formats recognised at the top of a document.
 *
 * `yaml` covers `---` delimited blocks, `toml` covers `+++`. remark-frontmatter
 * parses them into dedicated `yaml` / `toml` nodes, which keeps the opening
 * `---` from being read as a horizontal rule with the metadata leaking out as
 * body text. Those nodes are then rendered as a key/value table — see
 * `getRemarkRehypeOptions`.
 */
const FRONTMATTER_FORMATS = ['yaml', 'toml'] as const;

/** Remark plugins: frontmatter first, so `---` is consumed before GFM sees it. */
export function getRemarkPlugins(): PluggableList {
  return [[remarkFrontmatter, [...FRONTMATTER_FORMATS]], remarkGfm, remarkMath];
}

/** Rehype plugins: sanitize before the trusted HTML generators run. */
export function getRehypePlugins(): PluggableList {
  return [[rehypeSanitize, markdownSanitizeSchema], rehypeHighlight, rehypeKatex];
}

/**
 * mdast → hast options, used to render frontmatter instead of discarding it.
 *
 * `mdast-util-to-hast` ships `yaml` and `toml` mapped to its `ignore` handler,
 * so without this the block would not appear in the preview at all. Replacing
 * the handlers is the only hook that works: `ignore` returns before
 * `applyData`, so the usual `data.hName` route is unavailable.
 */
export function getRemarkRehypeOptions(): RemarkRehypeOptions {
  return {
    handlers: {
      yaml: (_state: unknown, node: Literal) => frontmatterToHast(node.value, 'yaml'),
      toml: (_state: unknown, node: Literal) => frontmatterToHast(node.value, 'toml'),
    },
  };
}
