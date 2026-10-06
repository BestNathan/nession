import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { primaryAppClass } from '@/app/experiences/app/appTypography';

export function AppFilesSelectionTopBar({
  summary,
  onExit,
  onSelectAll,
}: {
  summary: string;
  onExit: () => void;
  onSelectAll: () => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-2)]"
      data-testid="files-app-selection-top"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 shrink-0"
        aria-label="Exit selection"
        onClick={() => onExit()}
      >
        <X className="size-5" aria-hidden />
      </Button>
      <span className={cn('min-w-0 flex-1 truncate text-center text-foreground', primaryAppClass)}>
        {summary}
      </span>
      <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => onSelectAll()}>
        All
      </Button>
    </div>
  );
}

export function AppFilesSelectionBottomBar({
  onCopy,
  onDelete,
  disabled,
}: {
  onCopy: () => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-around gap-2 border-t border-border bg-background px-[var(--nession-shell-space-2)] py-[var(--nession-shell-space-2)]',
        'pb-[max(var(--nession-shell-space-2),env(safe-area-inset-bottom))]',
      )}
      data-testid="files-app-selection-bottom"
    >
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onCopy()}>
        Copy
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        className="text-destructive hover:text-destructive"
        onClick={() => onDelete()}
      >
        Delete
      </Button>
    </div>
  );
}
