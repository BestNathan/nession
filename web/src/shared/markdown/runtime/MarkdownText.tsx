/**
 * Simplified Markdown renderer for Chat using the incremental mdast pipeline.
 *
 * This is a simplified version of DeepSeek's MarkdownText.tsx, adapted for Nession.
 * It uses the incremental parser for streaming and the direct mdast→React renderer.
 *
 * Simplifications from DeepSeek version:
 * - No file mentions (DeepSeek-specific feature)
 * - No path images (DeepSeek-specific feature)
 * - No complex reference target tracking (simplified for Phase 2)
 * - Basic footnote support (numbering only, no complex resolution)
 */

import { memo, useRef, type ReactNode } from 'react';
import { IncrementalMarkdownParser } from './incremental.ts';
import { parseGfm, parseGfmWithMath } from './parser.ts';
import { renderBlocks, type MarkdownLabels, type MarkdownRenderContext } from './render.tsx';
import 'katex/dist/katex.min.css';

export type { MarkdownLabels } from './render.tsx';

/**
 * Streaming render state for one growing message: the incremental parser
 * and cached frozen blocks.
 */
class StreamingRenderer {
  private readonly parser = new IncrementalMarkdownParser(parseGfm);
  private generation = -1;
  private frozenCount = 0;
  private frozenElements: ReactNode[] = [];
  private lastText: string | null = null;
  private lastRendered: ReactNode[] = [];

  /** @param labels - Localized Markdown chrome baked into cached elements. */
  constructor(private readonly labels: MarkdownLabels) {}

  /**
   * Render the current accumulated text. Idempotent per text value.
   * @param text - The full accumulated markdown source.
   * @returns Frozen elements and re-rendered tail.
   */
  render(text: string): ReactNode[] {
    if (text === this.lastText) {return this.lastRendered;}

    const { frozen, tail, generation } = this.parser.update(text);

    if (generation !== this.generation) {
      this.generation = generation;
      this.frozenCount = 0;
      this.frozenElements = [];
    }

    const newlyFrozen = frozen.slice(this.frozenCount);

    // Render newly frozen blocks
    const context: MarkdownRenderContext = {
      streaming: false,
      labels: this.labels,
      footnoteOrder: [],
      footnotes: new Map(),
    };

    const newFrozenElements = newlyFrozen.map((block) =>
      renderBlocks([block], context)[0]
    );

    this.frozenElements = [...this.frozenElements, ...newFrozenElements];
    this.frozenCount = frozen.length;

    // Render the tail
    const tailElements = renderBlocks(tail, { ...context, streaming: true });

    const result = [...this.frozenElements, ...tailElements];
    this.lastText = text;
    this.lastRendered = result;

    return result;
  }
}

/**
 * One settled full render: parse with math and render all blocks.
 */
function renderSettled(
  text: string,
  labels: MarkdownLabels,
): ReactNode[] {
  const root = parseGfmWithMath(text);
  const context: MarkdownRenderContext = {
    streaming: false,
    labels,
    footnoteOrder: [],
    footnotes: new Map(),
  };

  const blocks = renderBlocks(
    root.children.map((node, index) => ({
      node,
      key: node.position?.start.offset ?? -(index + 1),
    })),
    context
  );

  return blocks;
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

  if (rendererRef.current === null || rendererRef.current['labels'] !== labels) {
    rendererRef.current = new StreamingRenderer(labels);
  }

  const elements = streaming
    ? rendererRef.current.render(text)
    : renderSettled(text, labels);

  return <div className="markdown">{elements}</div>;
});
