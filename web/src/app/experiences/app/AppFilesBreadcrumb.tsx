import { MoreHorizontal, Search } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole } from '@/shared/typography/chromeRoles';
import { Button } from '@/components/ui/button';

export interface AppFilesBreadcrumbProps {
  segments: { path: string; label: string }[];
  onSelect: (path: string) => void;
  onOpenSearch: () => void;
  onOpenMore: () => void;
}

/**
 * Horizontal, scrollable path for the App Files navigator (#1140).
 *
 * The shell page header names only the current directory; the full path lives
 * here as tappable segments so deep trees stay reachable without indentation.
 */
export function AppFilesBreadcrumb({
  segments,
  onSelect,
  onOpenSearch,
  onOpenMore,
}: AppFilesBreadcrumbProps) {
  return (
    <div
      className="flex shrink-0 items-center gap-1 px-[var(--nession-shell-space-3)] pb-[var(--nession-shell-space-1)]"
      data-testid="files-app-breadcrumb"
    >
      <nav
        aria-label="Directory path"
        className={cn('flex min-w-0 flex-1 gap-1 overflow-x-auto text-muted-foreground', chromeMonoRole('secondary'))}
      >
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        return (
          <span key={segment.path} className="flex shrink-0 items-center gap-1">
            {index > 0 ? <span aria-hidden>/</span> : null}
            {isLast ? (
              <span className="truncate font-mono text-foreground">{segment.label}</span>
            ) : (
              <button
                type="button"
                className={cn(
                  'truncate font-mono underline-offset-2 hover:text-foreground hover:underline',
                )}
                onClick={() => onSelect(segment.path)}
              >
                {segment.label}
              </button>
            )}
          </span>
        );
      })}
      </nav>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-9 shrink-0"
        aria-label="Search files"
        onClick={() => onOpenSearch()}
      >
        <Search className="size-4" aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-9 shrink-0"
        aria-label="Folder actions"
        onClick={() => onOpenMore()}
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
