/**
 * Chat code block renderer for the incremental markdown runtime.
 *
 * Unlike the Document CodeBlock (which receives hast from rehype-highlight),
 * this component receives mdast Code nodes directly and performs highlighting
 * itself using highlight.js.
 */

import 'highlight.js/styles/github-dark-dimmed.css';
import { Copy } from 'lucide-react';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { copyToClipboard } from '@/shared/lib/clipboard';
import hljs from 'highlight.js';

interface ChatCodeBlockProps {
  value: string;
  language?: string;
}

/**
 * A fenced code block for Chat messages, with syntax highlighting and copy button.
 */
export function ChatCodeBlock({ value, language }: ChatCodeBlockProps) {
  const highlighted = useMemo(() => {
    if (!language) {
      return escapeHtml(value);
    }

    try {
      const result = hljs.highlight(value, { language, ignoreIllegals: true });
      return result.value;
    } catch {
      // If highlighting fails, fall back to plain text
      return escapeHtml(value);
    }
  }, [value, language]);

  const copy = () => {
    // Add trailing newline for proper file pasting (if not already present)
    const textToCopy = value.endsWith('\n') ? value : value + '\n';
    copyToClipboard(textToCopy).then(
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
      data-testid="chat-code-block"
      className="my-2 min-w-0 overflow-hidden rounded-[var(--nession-radius-surface)] border border-[var(--nession-conversation-code-border)]"
    >
      <div className="flex items-center justify-between gap-2 bg-[var(--nession-conversation-code-surface)] px-2 py-1">
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
          aria-label={language ? `Copy ${language} code` : 'Copy code'}
          className="text-[var(--nession-conversation-code-foreground)]"
          onClick={copy}
        >
          <Copy aria-hidden />
          Copy
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 text-[length:var(--nession-typography-code-size)] leading-[var(--nession-typography-code-line-height)]">
        <code
          className={language === undefined ? undefined : `language-${language}`}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
