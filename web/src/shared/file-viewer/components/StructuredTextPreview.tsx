import type { ReactNode } from 'react';
import type { JsonPreviewKind } from '../model/viewerRegistry';
import { MarkdownPreview } from './MarkdownPreview';
import { JsonPreview } from './JsonPreview';
import { JsonlPreview } from './JsonlPreview';

interface StructuredPreviewProps {
  filename: string;
  content: string;
  kind: 'markdown' | JsonPreviewKind;
  onMarkdownFallback?: () => void;
}

/**
 * The format-specific preview leaves behind one surface.
 *
 * Loading, errors, dirty revisions and chunked progress are the caller's data
 * lifecycle, not this presentation: the shared viewer renders authorized,
 * complete content. Files wraps it with its own edit/save affordances; Git
 * wraps it with its Git status.
 */
export function StructuredPreview({
  filename,
  content,
  kind,
  onMarkdownFallback,
}: StructuredPreviewProps): ReactNode {
  if (kind === 'markdown') {
    return <MarkdownPreview content={content} filename={filename} onFallback={onMarkdownFallback} />;
  }
  if (kind === 'jsonl') {
    return <JsonlPreview content={content} />;
  }
  return <JsonPreview content={content} />;
}
