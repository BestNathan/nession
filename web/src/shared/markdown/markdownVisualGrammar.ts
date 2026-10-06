/**
 * Canonical Markdown renderer visual grammar (#1451).
 *
 * Markdown is workload content, not application chrome. This owner is also the
 * adapter boundary around @tailwindcss/typography's prose vocabulary: consumers
 * may not use prose-sm/text-xs/leading-relaxed/etc directly, but this one recipe
 * may preserve the renderer's established visual contract while Nession owns
 * where that contract is consumed.
 *
 * This intentionally preserves the pre-#1451 render. #1451 is visual
 * governance, not a Markdown redesign; baseline pixels must not move merely
 * because ownership became explicit.
 */

export const markdownMessageRootClass = [
  'prose prose-sm max-w-none min-w-0',
  'prose-pre:bg-transparent prose-pre:p-0 prose-pre:m-0',
  'prose-code:before:content-none prose-code:after:content-none',
  'prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5 prose-code:rounded',
  'prose-code:text-xs prose-code:font-normal prose-code:text-foreground/80',
  'prose-a:text-action prose-a:no-underline hover:prose-a:underline',
  'prose-headings:font-semibold prose-headings:tracking-tight',
  'prose-h2:text-base prose-h3:text-sm prose-h4:text-sm',
  'prose-hr:border-border',
  'prose-li:marker:text-muted-foreground prose-li:my-0.5',
  'prose-table:border prose-table:border-border',
  'prose-th:border prose-th:border-border prose-th:px-2 prose-th:py-1 prose-th:text-left',
  'prose-td:border prose-td:border-border prose-td:px-2 prose-td:py-1',
  'prose-blockquote:border-l-2 prose-blockquote:border-border prose-blockquote:not-italic',
].join(' ');

export const markdownDocumentRootClass = [
  'prose prose-sm max-w-none dark:prose-invert',
  'prose-headings:text-foreground prose-headings:font-semibold prose-headings:tracking-tight',
  'prose-h1:text-lg prose-h2:text-base prose-h3:text-sm',
  'prose-p:text-foreground/85 prose-p:leading-relaxed',
  'prose-a:text-action prose-a:no-underline hover:prose-a:underline',
  'prose-code:text-foreground/80 prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5',
  'prose-code:rounded prose-code:text-xs prose-code:font-normal',
  'prose-pre:bg-muted/70 prose-pre:rounded-[var(--nession-radius-surface)] prose-pre:shadow-sm',
  'prose-blockquote:border-l-2 prose-blockquote:border-border prose-blockquote:pl-3 prose-blockquote:text-muted-foreground prose-blockquote:not-italic',
  'prose-table:border prose-table:border-border prose-table:rounded-[var(--nession-radius-surface)] prose-table:overflow-hidden',
  'prose-th:border prose-th:border-border prose-th:bg-muted/40 prose-th:px-3 prose-th:py-2 prose-th:text-xs prose-th:font-medium',
  'prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2 prose-td:text-xs',
  'prose-hr:border-border',
  'prose-img:rounded-[var(--nession-radius-surface)]',
  'prose-li:marker:text-muted-foreground prose-li:my-0.5',
  'prose-strong:text-foreground/90',
].join(' ');

export const markdownDocumentViewportClass =
  'markdown-preview overflow-y-auto h-full p-4 text-sm leading-relaxed';

export const markdownNoticeClass =
  'mb-3 flex items-center gap-2 rounded border border-border bg-muted px-3 py-2 text-muted-foreground';

export const markdownFallbackActionClass =
  'rounded bg-secondary px-3 py-1.5 text-secondary-foreground hover:bg-secondary/80';

export const markdownCodeBlockPreClass =
  'overflow-x-auto p-3 text-[length:var(--nession-typography-code-size)] leading-relaxed';
