// The syntax theme, owned here because this is the component whose body is
// highlighted. `MarkdownPreview` imports the same file for the File Browser;
// a stylesheet import is idempotent, and the previous arrangement — the theme
// living on one *consumer* — meant any other Markdown surface rendered
// highlighted spans with no colours applied to them at all.
import 'highlight.js/styles/github-dark-dimmed.css';
import { Copy } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { copyToClipboard } from '@/shared/lib/clipboard';
import type { HastElement } from './hast';

/**
 * A fenced code block, as a readable surface rather than a wall of text.
 *
 * ## This is a renderer boundary, not a second Markdown pipeline
 *
 * The highlighting is `rehype-highlight`'s, running in the shared plugin chain
 * (`previewPlugins.ts`) before React ever sees the tree. So the *body* here
 * already contains highlighted spans and owns its own ground — that ground is
 * the highlight theme's, and restating it as a Nession token would be a second
 * source for a value this component does not control. The **header** is the
 * part Nession owns, and it is the part that consumes `conversation.code.*`.
 *
 * ## Why the language comes from the hast node
 *
 * `rehype-highlight` rewrites the `<code>` element's children into highlight
 * spans, so the raw text is no longer a single string anywhere in the React
 * tree. The `node` prop is the pre-rewrite *element* — plain data — which makes
 * it the only place both facts are still recoverable: the language from the
 * `language-*` class `rehype-sanitize` was built to allow, and the source text
 * by concatenating the text nodes back together.
 *
 * Reaching for `children` instead would mean reading a rendered element's props
 * and hoping its shape holds; the node's shape is the hast spec.
 */
export function CodeBlock({
  node,
  children,
}: {
  node?: HastElement;
  children?: ReactNode;
}) {
  const code = firstElement(node, 'code');
  const language = languageOf(code);
  const source = textOf(code);

  const copy = () => {
    // The house pattern, verbatim from `platform/explorer/commands` — the
    // globally mounted `<Toaster>` is the feedback, and it is the only one this
    // app has. An icon swap or an `aria-live` region here would be a second
    // answer to the same question.
    copyToClipboard(source).then(
      () => {
        toast.success('Code copied');
      },
      () => {
        toast.error('Failed to copy code');
      },
    );
  };

  return (
    <div
      data-testid="code-block"
      // `overflow-hidden` so the header's surface and the body's share one
      // rounded outline; the scrolling lives on the `<pre>` below, never here,
      // or the header would scroll away with the code.
      className="my-2 min-w-0 overflow-hidden rounded-[var(--nession-radius-surface)] border border-[var(--nession-conversation-code-border)]"
    >
      <div className="flex items-center justify-between gap-2 bg-[var(--nession-conversation-code-surface)] px-2 py-1">
        {/* Absent when the fence declared no language, rather than a placeholder
            like "text": a label that is always there and sometimes wrong is
            worse than one that is sometimes absent. */}
        <span
          data-testid="code-block-language"
          className="font-mono text-[length:var(--nession-typography-code-size)] text-[var(--nession-conversation-code-foreground)]"
        >
          {language ?? ''}
        </span>
        <Button
          variant="ghost"
          size="xs"
          type="button"
          // The button carries no text, so its name is the only thing a screen
          // reader has. It is not decoration and must not be `aria-hidden`.
          aria-label={language ? `Copy ${language} code` : 'Copy code'}
          className="text-[var(--nession-conversation-code-foreground)]"
          onClick={copy}
        >
          <Copy aria-hidden />
          Copy
        </Button>
      </div>
      {/* `overflow-x-auto` and no wrapping: a wrapped code line is a line whose
          indentation lies, which matters more here than fitting the column. */}
      <pre className="overflow-x-auto p-3 text-[length:var(--nession-typography-code-size)] leading-[var(--nession-typography-code-line-height)]">
        {children}
      </pre>
    </div>
  );
}

function languageOf(code: HastElement | undefined): string | undefined {
  const className = code?.properties?.className;
  const names = Array.isArray(className) ? className.map(String) : [];
  const declared = names.find((name) => name.startsWith('language-'));
  return declared?.slice('language-'.length);
}

function textOf(node: HastElement | undefined): string {
  if (!node) {
    return '';
  }
  return node.children
    .map((child) => (child.type === 'text' ? child.value : textOf(asElement(child))))
    .join('');
}

function firstElement(node: HastElement | undefined, tagName: string) {
  return node?.children
    .map(asElement)
    .find((child): child is HastElement => child?.tagName === tagName);
}

function asElement(node: unknown): HastElement | undefined {
  const candidate = node as HastElement | undefined;
  return candidate?.type === 'element' ? candidate : undefined;
}
