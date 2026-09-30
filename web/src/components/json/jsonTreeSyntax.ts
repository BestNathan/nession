import { cn } from '@/shared/lib/utils';

/** Semantic JSON roles — Nession tokens only (#1199, no third-party palette). */
export const jsonSyntax = {
  key: 'text-primary font-medium',
  punct: 'text-muted-foreground',
  string: 'text-foreground',
  number: 'tabular-nums text-chart-4',
  literal: 'text-muted-foreground italic',
  meta: 'text-muted-foreground text-[length:var(--workspace-editor-action-font-size)]',
  bracket: 'text-muted-foreground',
} as const;

export function jsonPreviewSurfaceClass(className?: string) {
  return cn(
    'min-w-0 rounded-md border border-[var(--conversation-code-border)]',
    'bg-[var(--conversation-code-surface)]/50',
    'px-[var(--shell-space-2)] py-[var(--shell-space-1)]',
    className,
  );
}

/** Collapsed JSONL body: scan-friendly height cap + fade (#1199 visual contract). */
export function jsonlRecordBodyClass(expanded: boolean, className?: string) {
  return cn(
    jsonPreviewSurfaceClass(),
    !expanded && 'max-h-[calc(var(--workspace-editor-line-height)*9em)] overflow-hidden',
    className,
  );
}
