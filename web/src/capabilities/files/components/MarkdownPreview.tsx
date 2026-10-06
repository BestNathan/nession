import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark-dimmed.css';
import { Component, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Info } from 'lucide-react';
import { getRehypePlugins, getRemarkPlugins, getRemarkRehypeOptions } from '@/shared/markdown';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import {
  markdownDocumentRootClass,
  markdownDocumentViewportClass,
  markdownFallbackActionClass,
  markdownNoticeClass,
} from '@/shared/markdown/markdownVisualGrammar';

/** Props for MarkdownPreview */
interface MarkdownPreviewProps {
  content: string;
  filename: string;
}

/** Props for MarkdownErrorBoundary */
interface ErrorBoundaryProps {
  children: ReactNode;
  onFallback: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/** Catches rendering errors and shows a fallback UI. */
export class MarkdownErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className={cn('flex h-full flex-col items-center justify-center gap-3 p-4 text-muted-foreground', chromeSansRole('secondary'))}>
          <p>Preview unavailable</p>
          <button
            type="button"
            onClick={this.props.onFallback}
            className={cn(markdownFallbackActionClass, chromeSansRole('metadata'))}
          >
            Show raw
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const LARGE_FILE_THRESHOLD = 1_048_576; // 1MB

/**
 * Renders markdown content with GFM, LaTeX math, YAML/TOML frontmatter, and
 * syntax highlighting. The plugin chain lives in `@/shared/markdown/previewPlugins`.
 * Code blocks use highlight.js github-dark-dimmed theme.
 */
export function MarkdownPreview({ content, filename }: MarkdownPreviewProps) {
  const isLargeFile = content.length > LARGE_FILE_THRESHOLD;

  const handleErrorFallback = () => {
    // Dispatch a custom event that FileViewer listens to
    window.dispatchEvent(new CustomEvent('markdown-preview-error', { detail: { filename } }));
  };

  return (
    <MarkdownErrorBoundary onFallback={handleErrorFallback}>
      <div className={cn(markdownDocumentViewportClass, workspaceScrollClearanceClass)}>
        {isLargeFile && (
          <div className={cn(markdownNoticeClass, chromeSansRole('metadata'))}>
            <Info className="h-3.5 w-3.5 shrink-0" />
            <span>Large file — rendering may be slow</span>
          </div>
        )}
        <div className={cn(markdownDocumentRootClass, 'dark:prose-invert')}>
          <ReactMarkdown
            remarkPlugins={getRemarkPlugins()}
            rehypePlugins={getRehypePlugins()}
            remarkRehypeOptions={getRemarkRehypeOptions()}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </MarkdownErrorBoundary>
  );
}
