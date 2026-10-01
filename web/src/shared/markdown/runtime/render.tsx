/**
 * Direct mdast→React markdown renderer for Chat. Replaces the react-markdown /
 * remark-rehype pipeline with one switch over parsed nodes so streaming can
 * cache frozen blocks as React elements.
 *
 * Simplified from DeepSeek Harness render.tsx:
 * - No HoverCard, ImageLightbox, ImagePreview (DeepSeek-specific UI)
 * - No useMarkdownDelegate (file mention system)
 * - No LinkIconMedium (link type icons)
 * - Links open in new tab for external URLs
 * - Images render as plain img tags
 * - Raw HTML renders as literal text (not executed)
 * - Code blocks use ChatCodeBlock with highlight.js
 */

import { Fragment, createElement, type Key, type ReactNode } from 'react';
import type * as Md from 'mdast';
import type { Math, InlineMath } from 'mdast-util-math';
import { normalizeUri } from 'micromark-util-sanitize-uri';
import { renderTexToReact } from './katex.tsx';
import type { PositionedBlock } from './incremental.ts';
import { ChatCodeBlock } from './ChatCodeBlock.tsx';

/** Localized chrome for a Markdown document. */
export interface MarkdownLabels {
  code: {
    copyLabel: string;
    copiedLabel: string;
  };
  footnotes: string;
}

/** Rendering context threaded through the recursive render. */
export interface MarkdownRenderContext {
  streaming: boolean;
  labels: MarkdownLabels;
  footnoteOrder: number[];
  footnotes: Map<number, Md.FootnoteDefinition>;
  inLink?: boolean;
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
  image: (node, key) => renderImageContent(node as Md.Image, key),
  imageReference: (node, key) => renderImageContent(node as Md.ImageReference, key),
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
): ReactNode {
  if (node.type === 'image') {
    return renderImage(node, key);
  }
  return renderImageReference(node, key);
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
  switch (node.depth) {
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
    <div key={key} className="overflow-x-auto">
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

function renderLink(
  node: Md.Link,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const href = sanitizeUrl(normalizeUri(node.url));
  const isExternal = href.startsWith('http:') || href.startsWith('https:');

  return (
    <a
      key={key}
      href={href}
      target={isExternal ? '_blank' : undefined}
      rel={isExternal ? 'noopener noreferrer' : undefined}
    >
      {renderChildren(node.children, context)}
    </a>
  );
}

function renderLinkReference(
  node: Md.LinkReference,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  // Link references without definitions render as plain text
  return <span key={key}>{renderChildren(node.children, context)}</span>;
}

function renderImage(node: Md.Image, key: Key): ReactNode {
  const src = remoteImageUrl(normalizeUri(node.url));

  if (src === undefined) {
    return <span key={key}>{node.alt}</span>;
  }

  return <img key={key} src={src} alt={node.alt ?? ''} />;
}

function renderImageReference(
  node: Md.ImageReference,
  key: Key,
): ReactNode {
  // Image references without definitions render as alt text
  return <span key={key}>{node.alt}</span>;
}

function renderFootnoteReference(
  node: Md.FootnoteReference,
  key: Key,
  context: MarkdownRenderContext,
): ReactNode {
  const index = context.footnoteOrder.indexOf(Number(node.identifier));
  const displayIndex = index >= 0 ? index + 1 : context.footnoteOrder.length + 1;

  if (index < 0) {
    context.footnoteOrder.push(Number(node.identifier));
  }

  return (
    <sup key={key}>
      <a href={`#fn-${node.identifier}`}>[{displayIndex}]</a>
    </sup>
  );
}
