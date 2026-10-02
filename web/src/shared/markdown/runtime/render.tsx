/**
 * Direct mdast→React markdown renderer for Chat. Replaces the react-markdown /
 * remark-rehype pipeline with one switch over parsed nodes so streaming can
 * cache frozen blocks as React elements.
 *
 * Upstream: https://github.com/deepseek-ai/deepseek-harness
 * Baseline: 21638c56315ae6a2b552d6091945d3144c9af32e
 * Source: packages/client/ui-primitives/src/markdown/render.tsx
 * License: MIT (see THIRD_PARTY_NOTICES.md)
 * Adaptation: Simplified for Nession, and the product semantics are
 * Nession-owned: no HoverCard, ImageLightbox, ImagePreview or
 * useMarkdownDelegate (DeepSeek-specific UI); no LinkIconMedium link glyph;
 * links are plain anchors opening external URLs in a new tab; images render as
 * plain `img` tags; raw HTML renders as literal text (never executed); code
 * blocks use ChatCodeBlock with highlight.js; tables use a bare responsive
 * wrapper; a destination that fails the protocol allowlist renders as
 * non-clickable text rather than an empty-href anchor; footnote chrome is
 * Nession markup (`[n]` reference links to a trailing section). Reference and
 * footnote *resolution* (`collectReferenceTargets`, footnote numbering and the
 * trailing section) is kept from upstream because settled correctness depends
 * on it.
 */

import { Fragment, createElement, type Key, type ReactNode } from 'react';
import type * as Md from 'mdast';
import type { Math, InlineMath } from 'mdast-util-math';
import { normalizeUri } from 'micromark-util-sanitize-uri';
import { renderTexToReact } from './katex.tsx';
import type { PositionedBlock } from './incremental.ts';
import { ChatCodeBlock } from './ChatCodeBlock.tsx';
import styles from '../ChatMarkdown.module.css';

/** Localized chrome for a Markdown document. */
export interface MarkdownLabels {
  code: {
    copyLabel: string;
    copiedLabel: string;
  };
  footnotes: string;
}

/**
 * Link/image reference targets collected from one parse: definitions resolve
 * `linkReference` / `imageReference` nodes, footnote definitions fill the
 * trailing section. Keyed by upper-cased identifier, first definition wins —
 * CommonMark's rule, and the reason a definition that arrives later in the
 * document still resolves earlier references.
 */
export interface ReferenceTargets {
  definitions: Map<string, Md.Definition>;
  footnotes: Map<string, Md.FootnoteDefinition>;
}

/**
 * Create an empty {@link ReferenceTargets}.
 * @returns Fresh empty maps.
 */
export function createReferenceTargets(): ReferenceTargets {
  return { definitions: new Map(), footnotes: new Map() };
}

/**
 * Record every definition and footnote definition under `nodes` into
 * `targets`, depth-first, keeping the first definition per identifier.
 * @param nodes - Subtrees to walk (top-level blocks or any nested children).
 * @param targets - Accumulator, shared across the incremental segments of a
 * streaming render so a frozen block's targets stay reachable.
 */
export function collectReferenceTargets(
  nodes: readonly Md.RootContent[],
  targets: ReferenceTargets,
): void {
  for (const node of nodes) {
    if (node.type === 'definition') {
      const id = node.identifier.toUpperCase();
      if (!targets.definitions.has(id)) {targets.definitions.set(id, node);}
    } else if (node.type === 'footnoteDefinition') {
      const id = node.identifier.toUpperCase();
      if (!targets.footnotes.has(id)) {targets.footnotes.set(id, node);}
    }
    if ('children' in node) {collectReferenceTargets(node.children, targets);}
  }
}

/** Rendering context threaded through the recursive render. */
export interface MarkdownRenderContext {
  streaming: boolean;
  labels: MarkdownLabels;
  /** Reference targets visible to this pass. */
  targets: ReferenceTargets;
  /** Footnote identifiers in first-reference order; a footnote's number is its 1-based index here. */
  footnoteOrder: string[];
  /** References rendered per identifier; drives a repeated reference's anchor id. */
  footnoteCounts: Map<string, number>;
}

function sanitizeUrl(url: string): string {
  try {
    switch (new URL(url).protocol) {
      case 'http:':
      case 'https:':
      case 'mailto:':
        return url;
      default:
        return '';
    }
  } catch {
    return '';
  }
}

function remoteImageUrl(url: string): string | undefined {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Render an mdast tree to React elements.
 */
export function renderBlocks(
  blocks: readonly PositionedBlock[],
  context: MarkdownRenderContext,
): ReactNode[] {
  return blocks.map((block) => renderNode(block.node, block.key, context));
}

/**
 * Render one mdast node to React elements.
 * Uses a dispatch map to reduce cyclomatic complexity.
 */
export function renderNode(
  node: Md.RootContent,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const renderer = nodeRenderers[node.type];
  return renderer ? renderer(node, key, context) : null;
}

/**
 * Dispatch map for mdast node renderers.
 * Each renderer handles one or more node types with the same signature.
 */
const nodeRenderers: Record<
  string,
  (node: Md.RootContent, key: Key, context: MarkdownRenderContext) => ReactNode
> = {
  text: (node) => (node as Md.Text).value,
  html: (node) => (node as Md.Html).value,
  thematicBreak: (_node, key) => <hr key={key} />,
  break: (_node, key) => <br key={key} />,
  strong: (node, key, context) => renderInlineFormat(node as Md.Strong, key, context),
  emphasis: (node, key, context) => renderInlineFormat(node as Md.Emphasis, key, context),
  delete: (node, key, context) => renderInlineFormat(node as Md.Delete, key, context),
  math: (node, key) => renderMath(node as Math, key),
  inlineMath: (node, key) => renderMath(node as InlineMath, key),
  paragraph: (node, key, context) => renderContainer(node as Md.Paragraph, key, context),
  blockquote: (node, key, context) => renderContainer(node as Md.Blockquote, key, context),
  heading: (node, key, context) => renderTextContent(node as Md.Heading, key, context),
  inlineCode: (node, key, context) => renderTextContent(node as Md.InlineCode, key, context),
  code: (node, key, context) => renderTextContent(node as Md.Code, key, context),
  list: (node, key, context) => renderListContent(node as Md.List, key, context),
  listItem: (node, key, context) => renderListContent(node as Md.ListItem, key, context),
  table: (node, key, context) => renderTable(node as Md.Table, key, context),
  link: (node, key, context) => renderLinkContent(node as Md.Link, key, context),
  linkReference: (node, key, context) => renderLinkContent(node as Md.LinkReference, key, context),
  image: (node, key, context) => renderImageContent(node as Md.Image, key, context),
  imageReference: (node, key, context) => renderImageContent(node as Md.ImageReference, key, context),
  footnoteReference: (node, key, context) => renderFootnoteReference(node as Md.FootnoteReference, key, context),
};

function renderContainer(
  node: Md.Paragraph | Md.Blockquote,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const children = renderChildren(node.children, context);
  if (node.type === 'paragraph') {
    return <p key={key}>{children}</p>;
  }
  return <blockquote key={key}>{children}</blockquote>;
}

function renderTextContent(
  node: Md.Heading | Md.InlineCode | Md.Code,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  if (node.type === 'heading') {
    return renderHeading(node, key, context);
  }
  if (node.type === 'inlineCode') {
    return renderInlineCode(node, key);
  }
  return renderCode(node, key, context);
}

function renderListContent(
  node: Md.List | Md.ListItem,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  if (node.type === 'list') {
    return renderList(node, key, context);
  }
  return renderListItem(node, listItemLoose(node), key, context);
}

function renderLinkContent(
  node: Md.Link | Md.LinkReference,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  if (node.type === 'link') {
    return renderLink(node, key, context);
  }
  return renderLinkReference(node, key, context);
}

function renderImageContent(
  node: Md.Image | Md.ImageReference,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  if (node.type === 'image') {
    return renderImage(node.url, node.alt ?? '', key);
  }
  return renderImageReference(node, key, context);
}

function renderInlineFormat(
  node: Md.Strong | Md.Emphasis | Md.Delete,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const children = renderChildren(node.children, context);
  if (node.type === 'strong') {
    return <strong key={key}>{children}</strong>;
  }
  if (node.type === 'emphasis') {
    return <em key={key}>{children}</em>;
  }
  return <del key={key}>{children}</del>;
}

function renderMath(node: Math | InlineMath, key: Key): ReactNode {
  return <Fragment key={key}>{renderTexToReact(node.value, node.type === 'math')}</Fragment>;
}

function renderInlineCode(node: Md.InlineCode, key: Key): ReactNode {
  const value = node.value.replace(/\r?\n|\r/g, ' ');
  return <code key={key}>{value}</code>;
}

function renderChildren(
  children: readonly Md.RootContent[] | readonly Md.PhrasingContent[],
  context: MarkdownRenderContext,
): ReactNode {
  return children.map((child, index) =>
    renderNode(child as Md.RootContent, index, context),
  );
}

function renderHeading(
  node: Md.Heading,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const children = renderChildren(node.children, context);
  // Downgrade heading levels by one to avoid conflicting with the page's own heading.
  // h1→h2, h2→h3, h3→h4, h4→h5, h5→h6, h6→h6 (two levels share one).
  const depth = Math.min(node.depth + 1, 6);
  switch (depth) {
    case 1:
      return <h1 key={key}>{children}</h1>;
    case 2:
      return <h2 key={key}>{children}</h2>;
    case 3:
      return <h3 key={key}>{children}</h3>;
    case 4:
      return <h4 key={key}>{children}</h4>;
    case 5:
      return <h5 key={key}>{children}</h5>;
    case 6:
      return <h6 key={key}>{children}</h6>;
    default:
      return <p key={key}>{children}</p>;
  }
}

function renderCode(
  node: Md.Code,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const language = node.lang ?? undefined;

  if (node.value === '') {
    return (
      <pre key={key}>
        <code className={language === undefined ? undefined : `language-${language}`} />
      </pre>
    );
  }

  const lang = language === undefined ? undefined : /^[\w-]+/.exec(language)?.[0];

  if (!context.streaming && lang === 'math') {
    return <Fragment key={key}>{renderTexToReact(`${node.value}\n`, true)}</Fragment>;
  }

  return (
    <ChatCodeBlock
      key={key}
      value={node.value}
      language={lang}
    />
  );
}

function renderList(
  node: Md.List,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const Tag = node.ordered ? 'ol' : 'ul';
  return createElement(
    Tag,
    { key, start: node.start ?? undefined },
    renderChildren(node.children, context),
  );
}

function renderListItem(
  node: Md.ListItem,
  loose: boolean,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const children = node.children.map((child, index) => {
    const rendered = renderNode(child, index, context);
    if (!loose && child.type === 'paragraph') {
      return <span key={index}>{rendered}</span>;
    }
    return rendered;
  });

  return (
    <li key={key}>
      {node.checked !== null && node.checked !== undefined && (
        <input type="checkbox" checked={node.checked} readOnly />
      )}
      {children}
    </li>
  );
}

function listItemLoose(node: Md.ListItem): boolean {
  return node.children.length > 1 || node.children.some((child) => child.type !== 'paragraph');
}

function renderTable(
  node: Md.Table,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const header = node.children[0];
  const body = node.children.slice(1);

  return (
    // `tableScroll` is the port's own responsive wrapper: it owns the
    // horizontal overflow and the cell chrome. It was written but never
    // applied, so every chat table rendered as bare cells (#1184 Playwright
    // pass).
    <div key={key} className={styles.tableScroll}>
      <table>
        <thead>
          <tr>
            {header.children.map((cell, index) => {
              const align = (cell as Md.TableCell & { align?: 'left' | 'center' | 'right' | null }).align;
              return (
                <th key={index} align={align ?? undefined}>
                  {renderChildren(cell.children, context)}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.children.map((cell, cellIndex) => {
                const align = (cell as Md.TableCell & { align?: 'left' | 'center' | 'right' | null }).align;
                return (
                  <td key={cellIndex} align={align ?? undefined}>
                    {renderChildren(cell.children, context)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * An anchor over an authored destination: a destination that passes the
 * protocol allowlist renders as a link, anything else — a local path, a
 * relative destination, an unknown scheme, an in-page fragment — renders as
 * plain text with no anchor at all. A local path does not become clickable
 * until a Nession-owned resolver vouches for it, and an empty-`href` anchor is
 * a broken promise rather than a degraded link (`#1184` security).
 */
function renderSafeAnchor(
  url: string,
  children: ReactNode,
  key: Key,
): ReactNode {
  const href = sanitizeUrl(normalizeUri(url));
  if (href === '') {
    return <Fragment key={key}>{children}</Fragment>;
  }
  const isExternal = href.startsWith('http:') || href.startsWith('https:');

  return (
    <a
      key={key}
      href={href}
      target={isExternal ? '_blank' : undefined}
      rel={isExternal ? 'noopener noreferrer' : undefined}
    >
      {children}
    </a>
  );
}

function renderLink(
  node: Md.Link,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  return renderSafeAnchor(node.url, renderChildren(node.children, context), key);
}

/** The bracketed source text a reference reverts to when its definition is missing. */
function referenceSuffix(node: Md.LinkReference | Md.ImageReference): string {
  if (node.referenceType === 'collapsed') {return '][]';}
  if (node.referenceType === 'full') {return `][${node.label ?? node.identifier}]`;}
  return ']';
}

function renderLinkReference(
  node: Md.LinkReference,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const definition = context.targets.definitions.get(node.identifier.toUpperCase());
  if (definition === undefined) {
    // Unresolved: either the definition genuinely does not exist or — while
    // streaming — it sits on the other side of a freeze boundary. Both revert
    // to the bracketed source text, which is literal, not an anchor; the
    // settled full parse resolves every reference the document defines.
    return (
      <Fragment key={key}>
        {'['}
        {renderChildren(node.children, context)}
        {referenceSuffix(node)}
      </Fragment>
    );
  }
  return renderSafeAnchor(definition.url, renderChildren(node.children, context), key);
}

function renderImage(url: string, alt: string, key: Key): ReactNode {
  const src = remoteImageUrl(normalizeUri(url));

  if (src === undefined) {
    return <span key={key}>{alt}</span>;
  }

  return <img key={key} src={src} alt={alt} />;
}

function renderImageReference(
  node: Md.ImageReference,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const definition = context.targets.definitions.get(node.identifier.toUpperCase());
  if (definition === undefined) {
    return `![${node.alt ?? ''}${referenceSuffix(node)}`;
  }
  return renderImage(definition.url, node.alt ?? '', key);
}

/** DOM id of footnote `number`'s section entry. */
function footnoteSectionItemId(number: number): string {
  return `fn-${number}`;
}

/** DOM id of one reference to footnote `number`; `occurrence` counts from 1. */
function footnoteReferenceId(number: number, occurrence: number): string {
  return occurrence === 1 ? `fnref-${number}` : `fnref-${number}-${occurrence}`;
}

function renderFootnoteReference(
  node: Md.FootnoteReference,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const id = node.identifier.toUpperCase();
  const seen = context.footnoteCounts.get(id);
  if (seen === undefined) {context.footnoteOrder.push(id);}
  const occurrence = (seen ?? 0) + 1;
  context.footnoteCounts.set(id, occurrence);
  const number = context.footnoteOrder.indexOf(id) + 1;

  return (
    <sup key={key}>
      <a id={footnoteReferenceId(number, occurrence)} href={`#${footnoteSectionItemId(number)}`}>
        [{number}]
      </a>
    </sup>
  );
}

/**
 * Render the trailing footnote section for every footnote referenced during
 * the pass, in first-reference order, each body carrying a back-link to the
 * first reference. A reference whose definition has not arrived renders its
 * number but contributes no entry — while streaming that is the documented
 * degradation; the settled full parse resolves the definition.
 * @param context - The pass state after all blocks rendered.
 * @returns The section, or null when no referenced footnote has a definition.
 */
export function renderFootnoteSection(context: MarkdownRenderContext): ReactNode | null {
  const items: ReactNode[] = [];
  for (const id of context.footnoteOrder) {
    const definition = context.targets.footnotes.get(id);
    if (definition === undefined) {continue;}
    const number = context.footnoteOrder.indexOf(id) + 1;
    const backref = <a href={`#${footnoteReferenceId(number, 1)}`} aria-label="Back to reference">↩</a>;
    const children = definition.children;
    const last = children[children.length - 1];
    // The back-link rides the body's last paragraph, where it reads as the end
    // of the note rather than a line of its own.
    const body = children.map((child, index) =>
      child.type === 'paragraph' && child === last
        ? <p key={index}>{renderChildren(child.children, context)} {backref}</p>
        : renderNode(child, index, context)
    );
    if (last?.type !== 'paragraph') {
      body.push(' ', backref);
    }
    items.push(
      <li key={id} id={footnoteSectionItemId(number)}>
        {body}
      </li>,
    );
  }
  if (items.length === 0) {return null;}
  return (
    <section key="footnotes" data-footnotes>
      <h2 className="sr-only">{context.labels.footnotes}</h2>
      <ol>{items}</ol>
    </section>
  );
}
