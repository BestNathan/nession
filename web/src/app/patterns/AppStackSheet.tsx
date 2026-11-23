import { Layers } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import type { WorkspaceStackAncestor } from '@/app/workspace/workspaceContext';

/**
 * The optional App Stack Sheet (#3971).
 *
 * The header's secondary line projects the *real* ancestry a capability
 * reported. Tapping it opens this sheet, which lists that ancestry root-first
 * with the current depth marked. Choosing an ancestor runs the capability's own
 * jump action, which is the same guard Back runs, so a dirty Files editor
 * cannot be discarded by a shortcut that skipped the confirmation.
 *
 * It is a sheet rather than a second navigation bar: the stack is temporary
 * context, not permanent chrome.
 */
export function AppStackSheet({
  open,
  onOpenChange,
  title,
  ancestors,
  onJumpToAncestor,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The current depth, shown as the marked last row. */
  title: string;
  /** Nearest ancestor first, ending at the capability root. */
  ancestors: readonly WorkspaceStackAncestor[];
  onJumpToAncestor: (id: string) => void;
}) {
  // Display root-first so the list reads like the path it projects.
  const path = [...ancestors].reverse();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        variant="sheet"
        data-experience="app"
        data-testid="app-stack-sheet"
      >
        <DialogHeader>
          <DialogTitle>Navigation stack</DialogTitle>
          <DialogDescription>
            Jump to an ancestor. Leaving the current level runs the same guard as Back.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-1 pb-[max(var(--nession-shell-space-3),env(safe-area-inset-bottom))]">
          {path.map((ancestor) => (
            <button
              key={ancestor.id}
              type="button"
              data-testid={`app-stack-ancestor-${ancestor.id}`}
              onClick={() => {
                onOpenChange(false);
                onJumpToAncestor(ancestor.id);
              }}
              className={cn(
                'flex min-h-11 w-full items-center gap-3 rounded-[var(--nession-radius-control)] px-2 py-2 text-left transition-colors',
                'hover:bg-accent hover:text-accent-foreground focus-visible:outline-solid focus-visible:outline-[length:var(--nession-focus-ring-width)] focus-visible:outline-ring focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))]',
              )}
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-[var(--nession-radius-control)] bg-muted text-muted-foreground">
                <Layers className="size-4" aria-hidden />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cn('truncate', chromeSansRole('primary'))}>{ancestor.title}</span>
                <span className={cn('truncate text-muted-foreground', chromeSansRole('caption'))}>
                  Jump to this level
                </span>
              </span>
            </button>
          ))}
          <div
            data-testid="app-stack-current"
            aria-current="page"
            className="flex min-h-11 w-full items-center gap-3 px-2 py-2"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-[var(--nession-radius-control)] bg-foreground text-background">
              <Layers className="size-4" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn('truncate', chromeSansRole('primary'))}>{title}</span>
              <span className={cn('truncate text-muted-foreground', chromeSansRole('caption'))}>
                Current location
              </span>
            </span>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
