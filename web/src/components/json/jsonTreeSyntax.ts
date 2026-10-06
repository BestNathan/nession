import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';

/** Semantic JSON roles — Nession tokens only (#1199, no third-party palette). */
export const jsonSyntax = {
  key: cn('text-primary', chromeMonoRole('code')),
  punct: 'text-muted-foreground',
  string: 'text-foreground',
  number: 'tabular-nums text-chart-4',
  literal: 'text-muted-foreground italic',
  meta: cn('text-muted-foreground', chromeSansRole('caption')),
  bracket: 'text-muted-foreground',
} as const;

export function jsonPreviewSurfaceClass(className?: string) {
  return cn(
    'min-w-0 rounded-[var(--nession-radius-surface)] border border-[var(--nession-conversation-code-border)]',
    'bg-[var(--nession-conversation-code-surface)]/50',
    'px-[var(--nession-shell-space-2)] py-[var(--nession-shell-space-1)]',
    className,
  );
}

/** Collapsed JSONL body: scan-friendly height cap + fade (#1199 visual contract). */
export function jsonlRecordBodyClass(expanded: boolean, className?: string) {
  return cn(
    jsonPreviewSurfaceClass(),
    !expanded && 'max-h-[calc(var(--nession-workspace-editor-line-height)*9em)] overflow-hidden',
    className,
  );
}
