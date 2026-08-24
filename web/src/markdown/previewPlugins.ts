import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { PluggableList } from 'unified';

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
 */
export const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    code: [['className', /^language-./, 'math-inline', 'math-display']],
  },
};

/**
 * Frontmatter formats recognised at the top of a document.
 *
 * `yaml` covers `---` delimited blocks, `toml` covers `+++`. remark-frontmatter
 * parses them into dedicated `yaml` / `toml` nodes; react-markdown has no
 * handler for those node types, so the block is dropped from the rendered HTML
 * rather than shown as a horizontal rule followed by stray text — matching how
 * GitHub presents frontmatter.
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
