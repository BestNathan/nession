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
  // #4115: the band's border, ground and bottom padding belong to the Host's
  // Bottom Actions slot. This element contributes the action row itself, so it
  // stays usable above the floating Capsule at every overlay height without
  // computing a safe-area or Capsule value in Files.
  return (
    <div
      className={cn(
        'flex items-center justify-around gap-2 px-[var(--nession-shell-space-2)] py-[var(--nession-shell-space-2)]',
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
