/**
 * Canonical Markdown renderer visual grammar (#1451).
 *
 * Markdown is workload content, not application chrome. It owns a renderer
 * grammar rather than borrowing chrome typography wholesale, while every hard
 * visual decision still resolves through the generated Nession vocabulary.
 *
 * Keep these classes literal: Tailwind must see every variant at build time.
 */

export const markdownMessageRootClass = [
  'prose max-w-none min-w-0',
  'prose-p:text-[length:var(--nession-typography-body-size)]',
  'prose-p:font-[number:var(--nession-typography-body-weight)]',
  'prose-p:leading-[var(--nession-typography-body-line-height)]',
  'prose-headings:font-[number:var(--nession-typography-title-weight)]',
  'prose-h2:text-[length:var(--nession-typography-primary-size)]',
  'prose-h2:leading-[var(--nession-typography-primary-line-height)]',
  'prose-h3:text-[length:var(--nession-typography-body-size)]',
  'prose-h3:leading-[var(--nession-typography-body-line-height)]',
  'prose-h4:text-[length:var(--nession-typography-body-size)]',
  'prose-h4:leading-[var(--nession-typography-body-line-height)]',
  'prose-pre:bg-transparent prose-pre:p-0 prose-pre:m-0 prose-pre:shadow-none',
  'prose-code:before:content-none prose-code:after:content-none',
  'prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5',
  'prose-code:rounded-[var(--nession-radius-control)]',
  'prose-code:text-[length:var(--nession-typography-code-size)]',
  'prose-code:font-[number:var(--nession-typography-code-weight)]',
  'prose-code:leading-[var(--nession-typography-code-line-height)]',
  'prose-code:text-foreground/80',
  'prose-a:text-action prose-a:no-underline hover:prose-a:underline',
  'prose-hr:border-border',
  'prose-li:marker:text-muted-foreground prose-li:my-0.5',
  'prose-table:border prose-table:border-border',
  'prose-th:border prose-th:border-border prose-th:px-2 prose-th:py-1 prose-th:text-left',
  'prose-th:text-[length:var(--nession-typography-metadata-size)]',
  'prose-th:font-[number:var(--nession-typography-metadata-weight)]',
  'prose-th:leading-[var(--nession-typography-metadata-line-height)]',
  'prose-td:border prose-td:border-border prose-td:px-2 prose-td:py-1',
  'prose-td:text-[length:var(--nession-typography-metadata-size)]',
  'prose-td:leading-[var(--nession-typography-metadata-line-height)]',
  'prose-blockquote:border-l-2 prose-blockquote:border-border prose-blockquote:not-italic',
].join(' ');

export const markdownDocumentRootClass = [
  'prose max-w-none',
  'prose-p:text-[length:var(--nession-typography-body-size)]',
  'prose-p:font-[number:var(--nession-typography-body-weight)]',
  'prose-p:leading-[var(--nession-typography-body-line-height)] prose-p:text-foreground/85',
  'prose-headings:font-[number:var(--nession-typography-title-weight)] prose-headings:text-foreground',
  'prose-h1:text-[length:var(--nession-typography-title-size)]',
  'prose-h1:leading-[var(--nession-typography-title-line-height)]',
  'prose-h2:text-[length:var(--nession-typography-primary-size)]',
  'prose-h2:leading-[var(--nession-typography-primary-line-height)]',
  'prose-h3:text-[length:var(--nession-typography-body-size)]',
  'prose-h3:leading-[var(--nession-typography-body-line-height)]',
  'prose-a:text-action prose-a:no-underline hover:prose-a:underline',
  'prose-code:text-foreground/80 prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5',
  'prose-code:rounded-[var(--nession-radius-control)]',
  'prose-code:text-[length:var(--nession-typography-code-size)]',
  'prose-code:font-[number:var(--nession-typography-code-weight)]',
  'prose-code:leading-[var(--nession-typography-code-line-height)]',
  'prose-pre:bg-muted/70 prose-pre:rounded-[var(--nession-radius-surface)] prose-pre:shadow-none',
  'prose-blockquote:border-l-2 prose-blockquote:border-border prose-blockquote:pl-3 prose-blockquote:text-muted-foreground prose-blockquote:not-italic',
  'prose-table:border prose-table:border-border prose-table:rounded-[var(--nession-radius-surface)] prose-table:overflow-hidden',
  'prose-th:border prose-th:border-border prose-th:bg-muted/40 prose-th:px-3 prose-th:py-2',
  'prose-th:text-[length:var(--nession-typography-metadata-size)]',
  'prose-th:font-[number:var(--nession-typography-metadata-weight)]',
  'prose-th:leading-[var(--nession-typography-metadata-line-height)]',
  'prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2',
  'prose-td:text-[length:var(--nession-typography-metadata-size)]',
  'prose-td:leading-[var(--nession-typography-metadata-line-height)]',
  'prose-hr:border-border',
  'prose-img:rounded-[var(--nession-radius-surface)]',
  'prose-li:marker:text-muted-foreground prose-li:my-0.5',
  'prose-strong:text-foreground/90',
].join(' ');

export const markdownDocumentViewportClass = [
  'markdown-preview h-full overflow-y-auto p-4',
  'text-[length:var(--nession-typography-body-size)]',
  'font-[number:var(--nession-typography-body-weight)]',
  'leading-[var(--nession-typography-body-line-height)]',
].join(' ');

export const markdownNoticeClass =
  'mb-3 flex items-center gap-2 rounded-[var(--nession-radius-control)] border border-border bg-muted px-3 py-2 text-muted-foreground';

export const markdownFallbackActionClass =
  'rounded-[var(--nession-radius-control)] bg-secondary px-3 py-1.5 text-secondary-foreground hover:bg-secondary/80';
