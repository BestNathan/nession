import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.css';
import { Component, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { Info } from 'lucide-react';

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
 * Sanitize schema for markdown previews.
 *
 * Extends the default GitHub-style schema so the raw markdown HTML can be
 * sanitized *before* KaTeX and highlight.js run (they generate trusted HTML of
 * their own afterwards). remark-math marks math spans with
 * `math-inline` / `math-display` on `<code>`, so those class names must survive
 * the sanitize pass for rehype-katex to pick them up.
 */
const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    code: [['className', /^language-./, 'math-inline', 'math-display']],
  },
};

/**
 * Renders markdown content with GFM, LaTeX math, and syntax highlighting.
 * Code blocks use highlight.js github-dark theme.
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
          prose-headings:text-foreground prose-p:text-foreground
          prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
          prose-code:text-amber-300 prose-code:bg-muted/50 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
          prose-pre:bg-muted prose-pre:border prose-pre:border-border
          prose-blockquote:border-l-2 prose-blockquote:border-blue-500 prose-blockquote:pl-3 prose-blockquote:text-muted-foreground
          prose-table:border prose-table:border-border
          prose-th:border prose-th:border-border prose-th:bg-muted/50 prose-th:px-3 prose-th:py-1
          prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-1
          prose-hr:border-border
          prose-img:rounded
          prose-li:marker:text-muted-foreground
        ">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[
              [rehypeSanitize, markdownSanitizeSchema],
              rehypeHighlight,
              rehypeKatex,
            ]}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </MarkdownErrorBoundary>
  );
}
