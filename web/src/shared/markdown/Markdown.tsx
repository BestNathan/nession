// The math stylesheet, for the same reason `CodeBlock` owns the syntax theme:
// `rehype-katex` runs in this pipeline, so this is where its output is styled.
import 'katex/dist/katex.min.css';
import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { cn } from '@/shared/lib/utils';
import { CodeBlock } from './CodeBlock';
import type { HastElement } from './hast';
import { getRehypePlugins, getRemarkPlugins, getRemarkRehypeOptions } from './previewPlugins';
import { markdownMessageRootClass } from './markdownVisualGrammar';

/**
 * Markdown, rendered — the primitive, without a surface around it.
 *
 * `MarkdownPreview` owns the File Browser's document treatment: an outer
 * scroller, file padding, a large-file banner, an error boundary that swaps in
 * a raw view. None of that is true of a chat message, and a second consumer
 * reaching through it for the plugin chain is how the two would drift. So the
 * *pipeline* is shared (`previewPlugins.ts`) and the two surfaces are separate:
 * this renders content, `MarkdownPreview` renders a document.
 *
 * ## The plugin chain is the same one, including its sanitizer
 *
 * `getRehypePlugins()` runs `rehype-sanitize` **before** `rehype-highlight` and
 * `rehype-katex`, which is the whole security posture: the sanitizer vets what
 * the author wrote, and the two after it are trusted generators whose output
 * must not be stripped. Nothing here weakens that, and there is no `rehype-raw`
 * anywhere in the tree — raw HTML in a message is dropped, not executed.
 *
 * ## Headings are levelled down
 *
 * A message is not a page. A `#` in a reply rendered as an `<h1>` would compete
 * with the Workspace's own heading, and a screen-reader user navigating by
 * heading would find the document outline rewritten by whatever the model
 * happened to write. Shifting every level down by one keeps the author's
 * *relative* structure — which is the part that carries meaning — while keeping
 * the message's headings inside the region that contains them.
 */
export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    // `min-w-0` because a Markdown surface must never be what widens its
    // container. Its default `min-width: auto` resolves to the min-content
    // width, which for a document containing a code fence is the longest
    // unwrapped line — so without this the block below forces the whole column
    // to that width instead of letting the fence scroll inside itself.
    <div className={cn(markdownMessageRootClass, className)}>
      <ReactMarkdown
        remarkPlugins={getRemarkPlugins()}
        rehypePlugins={getRehypePlugins()}
        remarkRehypeOptions={getRemarkRehypeOptions()}
        components={markdownComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

const markdownComponents: Components = {
  pre: ({ node, children }) => (
    <CodeBlock node={node as HastElement | undefined}>{children}</CodeBlock>
  ),
  // Levelled down — see the component docs. `h5`/`h6` both land on `h6` because
  // there is nothing below it to shift into, and a heading that is not a
  // heading is worse than two levels sharing one.
  h1: ({ children }) => <h2>{children}</h2>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h4>{children}</h4>,
  h4: ({ children }) => <h5>{children}</h5>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
  a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
};

/**
 * A link out of the app.
 *
 * `rel="noopener noreferrer"` because `target="_blank"` without it hands the
 * opened page a `window.opener` handle back into this one. Only for absolute
 * URLs: a relative href is Nession's own routing territory, and forcing it into
 * a new tab would take that decision away from wherever routing lives.
 */
function ExternalLink({ href, children }: { href?: string; children?: ReactNode }) {
  const external = typeof href === 'string' && /^https?:\/\//i.test(href);
  return (
    <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
      {children}
    </a>
  );
}
