/**
 * Canonical Markdown renderer visual grammar (#1451).
 *
 * Markdown is workload content, not application chrome. It therefore owns a
 * renderer grammar instead of borrowing `chromeSansRole` wholesale. The
 * grammar still resolves every hard visual decision through the generated
 * Nession vocabulary so chat and file-preview Markdown cannot drift into a
 * second type/radius/elevation system.
 */

const bodySize = 'text-[length:var(--nession-typography-body-size)]';
const bodyWeight = 'font-[number:var(--nession-typography-body-weight)]';
const bodyLeading = 'leading-[var(--nession-typography-body-line-height)]';
const primarySize = 'text-[length:var(--nession-typography-primary-size)]';
const primaryWeight = 'font-[number:var(--nession-typography-primary-weight)]';
const primaryLeading = 'leading-[var(--nession-typography-primary-line-height)]';
const titleSize = 'text-[length:var(--nession-typography-title-size)]';
const titleWeight = 'font-[number:var(--nession-typography-title-weight)]';
const titleLeading = 'leading-[var(--nession-typography-title-line-height)]';
const metadataSize = 'text-[length:var(--nession-typography-metadata-size)]';
const metadataWeight = 'font-[number:var(--nession-typography-metadata-weight)]';
const metadataLeading = 'leading-[var(--nession-typography-metadata-line-height)]';
const codeSize = 'text-[length:var(--nession-typography-code-size)]';
const codeWeight = 'font-[number:var(--nession-typography-code-weight)]';
const codeLeading = 'leading-[var(--nession-typography-code-line-height)]';

export const markdownMessageRootClass = [
  'prose max-w-none min-w-0',
  `prose-p:${bodySize} prose-p:${bodyWeight} prose-p:${bodyLeading}`,
  `prose-headings:${titleWeight}`,
  `prose-h2:${primarySize} prose-h2:${primaryLeading}`,
  `prose-h3:${bodySize} prose-h3:${bodyLeading}`,
  `prose-h4:${bodySize} prose-h4:${bodyLeading}`,
  'prose-pre:bg-transparent prose-pre:p-0 prose-pre:m-0 prose-pre:shadow-none',
  'prose-code:before:content-none prose-code:after:content-none',
  'prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5',
  'prose-code:rounded-[var(--nession-radius-control)]',
  `prose-code:${codeSize} prose-code:${codeWeight} prose-code:${codeLeading}`,
  'prose-code:text-foreground/80',
  'prose-a:text-action prose-a:no-underline hover:prose-a:underline',
  'prose-hr:border-border',
  'prose-li:marker:text-muted-foreground prose-li:my-0.5',
  'prose-table:border prose-table:border-border',
  'prose-th:border prose-th:border-border prose-th:px-2 prose-th:py-1 prose-th:text-left',
  `prose-th:${metadataSize} prose-th:${metadataWeight} prose-th:${metadataLeading}`,
  'prose-td:border prose-td:border-border prose-td:px-2 prose-td:py-1',
  `prose-td:${metadataSize} prose-td:${metadataLeading}`,
  'prose-blockquote:border-l-2 prose-blockquote:border-border prose-blockquote:not-italic',
].join(' ');

export const markdownDocumentRootClass = [
  'prose max-w-none',
  `prose-p:${bodySize} prose-p:${bodyWeight} prose-p:${bodyLeading}`,
  'prose-p:text-foreground/85',
  `prose-headings:${titleWeight}`,
  `prose-h1:${titleSize} prose-h1:${titleLeading}`,
  `prose-h2:${primarySize} prose-h2:${primaryLeading}`,
  `prose-h3:${bodySize} prose-h3:${bodyLeading}`,
  'prose-headings:text-foreground',
  'prose-a:text-action prose-a:no-underline hover:prose-a:underline',
  'prose-code:text-foreground/80 prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5',
  'prose-code:rounded-[var(--nession-radius-control)]',
  `prose-code:${codeSize} prose-code:${codeWeight} prose-code:${codeLeading}`,
  'prose-pre:bg-muted/70 prose-pre:rounded-[var(--nession-radius-surface)] prose-pre:shadow-none',
  'prose-blockquote:border-l-2 prose-blockquote:border-border prose-blockquote:pl-3 prose-blockquote:text-muted-foreground prose-blockquote:not-italic',
  'prose-table:border prose-table:border-border prose-table:rounded-[var(--nession-radius-surface)] prose-table:overflow-hidden',
  'prose-th:border prose-th:border-border prose-th:bg-muted/40 prose-th:px-3 prose-th:py-2',
  `prose-th:${metadataSize} prose-th:${metadataWeight} prose-th:${metadataLeading}`,
  'prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2',
  `prose-td:${metadataSize} prose-td:${metadataLeading}`,
  'prose-hr:border-border',
  'prose-img:rounded-[var(--nession-radius-surface)]',
  'prose-li:marker:text-muted-foreground prose-li:my-0.5',
  'prose-strong:text-foreground/90',
].join(' ');

export const markdownDocumentViewportClass = [
  'markdown-preview h-full overflow-y-auto p-4',
  bodySize,
  bodyWeight,
  bodyLeading,
].join(' ');

export const markdownNoticeClass =
  'mb-3 flex items-center gap-2 rounded-[var(--nession-radius-control)] border border-border bg-muted px-3 py-2 text-muted-foreground';

export const markdownFallbackActionClass =
  'rounded-[var(--nession-radius-control)] bg-secondary px-3 py-1.5 text-secondary-foreground hover:bg-secondary/80';
