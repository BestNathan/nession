/**
 * The Chat Markdown renderer over the incremental mdast pipeline: streaming
 * messages parse incrementally and cache frozen blocks as React elements,
 * settled messages take one full parse that is the authoritative result.
 *
 * Upstream: https://github.com/deepseek-ai/deepseek-harness
 * Baseline: 21638c56315ae6a2b552d6091945d3144c9af32e
 * Source: packages/client/ui-primitives/src/markdown/MarkdownText.tsx
 * License: MIT (see THIRD_PARTY_NOTICES.md)
 * Adaptation: Simplified for Nession — no file mentions, no path-image
 * vocabulary, no variant/density switch, no CSS-module chrome. Nession keeps
 * the incremental parser + cached-frozen-prefix lifecycle, the reference /
 * footnote state that frozen elements already consumed, and the settled full
 * parse as the canonical result.
 */

import { memo, useId, useRef, type ReactNode } from 'react';
import { IncrementalMarkdownParser } from './incremental.ts';
import { parseGfm, parseGfmWithMath } from './parser.ts';
import {
  collectReferenceTargets,
  createReferenceTargets,
  renderBlocks,
  renderFootnoteSection,
  type MarkdownLabels,
  type MarkdownRenderContext,
  type ReferenceTargets,
} from './render.tsx';
import 'katex/dist/katex.min.css';

export type { MarkdownLabels } from './render.tsx';

/**
 * Streaming render state for one growing message: the incremental parser, the
 * cached frozen blocks, and the reference/footnote state their rendering
 * consumed — a footnote number assigned while a block rendered is final, and
 * the tail continues from a copy of it each frame.
 */
class StreamingRenderer {
  private readonly parser = new IncrementalMarkdownParser(parseGfm);
  private generation = -1;
  private frozenCount = 0;
  private frozenElements: ReactNode[] = [];
  private frozenTargets: ReferenceTargets = createReferenceTargets();
  private frozenFootnoteOrder: string[] = [];
  private frozenFootnoteCounts = new Map<string, number>();
  private lastText: string | null = null;
  private lastRendered: ReactNode[] = [];

  /**
   * @param labels - Localized Markdown chrome baked into cached elements.
   * @param footnoteScope - Prefix for this document's footnote ids; fixed for
   * the message's lifetime so frozen elements keep the ids they were given.
   */
  constructor(
    private readonly labels: MarkdownLabels,
    private readonly footnoteScope: string,
  ) {}

  /**
   * Render the current accumulated text. Idempotent per text value.
   * @param text - The full accumulated markdown source.
   * @returns Frozen elements, the re-rendered tail, and the footnote section.
   */
  render(text: string): ReactNode[] {
    if (text === this.lastText) {return this.lastRendered;}

    const { frozen, tail, generation } = this.parser.update(text);

    if (generation !== this.generation) {
      this.generation = generation;
      this.frozenCount = 0;
      this.frozenElements = [];
      this.frozenTargets = createReferenceTargets();
      this.frozenFootnoteOrder = [];
      this.frozenFootnoteCounts = new Map();
    }

    const newlyFrozen = frozen.slice(this.frozenCount);
    collectReferenceTargets(newlyFrozen.map((block) => block.node), this.frozenTargets);

    // Targets visible this frame: everything frozen so far plus the current
    // tail parse, so a block that just froze resolved against the same parse
    // its definitions came from.
    const frameTargets: ReferenceTargets = {
      definitions: new Map(this.frozenTargets.definitions),
      footnotes: new Map(this.frozenTargets.footnotes),
    };
    collectReferenceTargets(tail.map((block) => block.node), frameTargets);

    if (newlyFrozen.length > 0) {
      const frozenContext: MarkdownRenderContext = {
        streaming: false,
        labels: this.labels,
        footnoteScope: this.footnoteScope,
        targets: frameTargets,
        // Both are used by reference: the numbering assigned in this pass is
        // final, and later frames continue from it.
        footnoteOrder: this.frozenFootnoteOrder,
        footnoteCounts: this.frozenFootnoteCounts,
      };
      const newFrozenElements = newlyFrozen.map((block) =>
        renderBlocks([block], frozenContext)[0]
      );
      this.frozenElements = [...this.frozenElements, ...newFrozenElements];
      this.frozenCount = frozen.length;
    }

    const tailContext: MarkdownRenderContext = {
      streaming: true,
      labels: this.labels,
      footnoteScope: this.footnoteScope,
      targets: frameTargets,
      footnoteOrder: [...this.frozenFootnoteOrder],
      footnoteCounts: new Map(this.frozenFootnoteCounts),
    };
    const tailElements = renderBlocks(tail, tailContext);
    const section = renderFootnoteSection(tailContext);

    const result = section === null
      ? [...this.frozenElements, ...tailElements]
      : [...this.frozenElements, ...tailElements, section];
    this.lastText = text;
    this.lastRendered = result;

    return result;
  }
}

/**
 * One settled full render: parse with math, resolve references, append the
 * footnote section. This is the canonical result — whatever streaming had to
 * render literally, this pass resolves.
 */
function renderSettled(
  text: string,
  labels: MarkdownLabels,
  footnoteScope: string,
): ReactNode[] {
  const root = parseGfmWithMath(text);
  const targets = createReferenceTargets();
  collectReferenceTargets(root.children, targets);
  const context: MarkdownRenderContext = {
    streaming: false,
    labels,
    footnoteScope,
    targets,
    footnoteOrder: [],
    footnoteCounts: new Map(),
  };

  const blocks = renderBlocks(
    root.children.map((node, index) => ({
      node,
      key: node.position?.start.offset ?? -(index + 1),
    })),
    context
  );
  const section = renderFootnoteSection(context);

  return section === null ? blocks : [...blocks, section];
}

export interface MarkdownTextProps {
  text: string;
  streaming?: boolean;
  labels: MarkdownLabels;
}

/**
 * Markdown renderer component for Chat messages.
 *
 * Uses incremental parsing for streaming messages to avoid re-parsing
 * the entire document on every update. Settled messages use the full
 * grammar with math support.
 */
export const MarkdownText = memo(function MarkdownText({
  text,
  streaming = false,
  labels,
}: MarkdownTextProps): ReactNode {
  const rendererRef = useRef<StreamingRenderer | null>(null);
  // One component instance is one Markdown document. `useId` gives this
  // instance an id React keeps stable across every render — including the
  // streaming → settled switch — which is exactly the lifetime a footnote's
  // DOM id needs: scoped to the message, so two messages' footnotes cannot
  // collide, and unchanged when the message settles.
  const footnoteScope = `${useId().replace(/[^a-zA-Z0-9_-]/g, '')}-`;

  if (rendererRef.current === null || rendererRef.current['labels'] !== labels) {
    rendererRef.current = new StreamingRenderer(labels, footnoteScope);
  }

  const elements = streaming
    ? rendererRef.current.render(text)
    : renderSettled(text, labels, footnoteScope);

  return <div className="markdown">{elements}</div>;
});
