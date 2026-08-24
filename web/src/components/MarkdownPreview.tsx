import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark-dimmed.css';
import { Component, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Info } from 'lucide-react';
import { getRehypePlugins, getRemarkPlugins } from '@/markdown';

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
        <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-sm text-muted-foreground">
          <p>Preview unavailable</p>
          <button
            onClick={this.props.onFallback}
            className="px-3 py-1.5 text-xs rounded bg-secondary hover:bg-secondary/80 text-secondary-foreground"
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
 * syntax highlighting. The plugin chain lives in `@/markdown/previewPlugins`.
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
      <div className="markdown-preview overflow-y-auto h-full p-4 text-sm leading-relaxed">
        {isLargeFile && (
          <div className="flex items-center gap-2 px-3 py-2 mb-3 text-xs rounded border bg-blue-950/50 border-blue-800 text-blue-200">
            <Info className="h-3.5 w-3.5 shrink-0" />
            <span>Large file — rendering may be slow</span>
          </div>
        )}
        <div className="prose prose-sm max-w-none dark:prose-invert
          prose-headings:text-foreground prose-headings:font-semibold prose-headings:tracking-tight
          prose-h1:text-lg prose-h2:text-base prose-h3:text-sm
          prose-p:text-foreground/85 prose-p:leading-relaxed
          prose-a:text-blue-300/80 prose-a:no-underline hover:prose-a:text-blue-300 hover:prose-a:underline
          prose-code:text-foreground/80 prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:font-normal
          prose-pre:bg-muted/70 prose-pre:rounded-lg prose-pre:shadow-sm
          prose-blockquote:border-l-2 prose-blockquote:border-border prose-blockquote:pl-3 prose-blockquote:text-muted-foreground prose-blockquote:not-italic
          prose-table:border prose-table:border-border prose-table:rounded-lg prose-table:overflow-hidden
          prose-th:border prose-th:border-border prose-th:bg-muted/40 prose-th:px-3 prose-th:py-2 prose-th:text-xs prose-th:font-medium
          prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2 prose-td:text-xs
          prose-hr:border-border
          prose-img:rounded-lg
          prose-li:marker:text-muted-foreground prose-li:my-0.5
          prose-strong:text-foreground/90
        ">
          <ReactMarkdown
            remarkPlugins={getRemarkPlugins()}
            rehypePlugins={getRehypePlugins()}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </MarkdownErrorBoundary>
  );
}
