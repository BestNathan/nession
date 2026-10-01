/**
 * Chat-specific Markdown wrapper component.
 *
 * Wraps MarkdownText with Chat-specific styling and labels.
 * This is the component that should be used in ConversationTranscript
 * for rendering assistant messages.
 */

import { type ReactNode } from 'react';
import { MarkdownText, type MarkdownLabels } from './runtime/MarkdownText.tsx';
import styles from './ChatMarkdown.module.css';

/** Default English labels for Chat Markdown chrome. */
const DEFAULT_LABELS: MarkdownLabels = {
  code: {
    copyLabel: 'Copy',
    copiedLabel: 'Copied',
  },
  footnotes: 'Footnotes',
};

export interface ChatMarkdownProps {
  /** The markdown source text. */
  text: string;
  /** Whether the message is still streaming (growing). */
  streaming?: boolean;
  /** Optional custom labels for localized chrome. Defaults to English. */
  labels?: MarkdownLabels;
}

/**
 * Chat Markdown renderer with Nession styling.
 *
 * Uses the incremental mdast pipeline for streaming messages and the full
 * grammar with math support for settled messages. Code blocks use highlight.js
 * for syntax highlighting.
 *
 * @example
 * ```tsx
 * <ChatMarkdown text="**Hello** world!" />
 * <ChatMarkdown text={growingText} streaming />
 * ```
 */
export function ChatMarkdown({
  text,
  streaming = false,
  labels = DEFAULT_LABELS,
}: ChatMarkdownProps): ReactNode {
  return (
    <div className={styles.markdown}>
      <MarkdownText text={text} streaming={streaming} labels={labels} />
    </div>
  );
}
