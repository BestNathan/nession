import { cn } from '@/shared/lib/utils';

export interface AppFilesBreadcrumbProps {
  segments: { path: string; label: string }[];
  onSelect: (path: string) => void;
}

/**
 * Horizontal, scrollable path for the App Files navigator (#1140).
 *
 * The shell page header names only the current directory; the full path lives
 * here as tappable segments so deep trees stay reachable without indentation.
 */
export function AppFilesBreadcrumb({ segments, onSelect }: AppFilesBreadcrumbProps) {
  return (
    <nav
      aria-label="Directory path"
      data-testid="files-app-breadcrumb"
      className="flex shrink-0 gap-1 overflow-x-auto px-[var(--shell-space-3)] pb-[var(--shell-space-1)] text-[length:var(--workspace-tree-font-size)] text-muted-foreground"
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
  );
}
