import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { FileEntry } from '@/capabilities/files';
import type { AppFilesSearchStatus } from './useAppFilesSearch';
import { cn } from '@/shared/lib/utils';
import { bodyAppClass, metadataAppClass, primaryAppClass, secondaryAppClass } from '@/app/experiences/app/appTypography';
import { chromeMonoRole } from '@/shared/typography/chromeRoles';

export interface AppFilesSearchPanelProps {
  query: string;
  onQueryChange: (value: string) => void;
  status: AppFilesSearchStatus;
  error: string | null;
  results: FileEntry[];
  onSelectFile: (entry: FileEntry) => void;
  onRetry: () => void;
}

export function AppFilesSearchPanel({
  query,
  onQueryChange,
  status,
  error,
  results,
  onSelectFile,
  onRetry,
}: AppFilesSearchPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="files-app-search">
      <div className="relative shrink-0 px-[var(--shell-space-3)] pb-[var(--shell-space-2)]">
        <Search
          className="pointer-events-none absolute left-[calc(var(--shell-space-3)+0.75rem)] top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search files"
          className="pl-9"
          autoFocus
          aria-label="Search files"
        />
      </div>
      {/* Bottom padding is the larger of the panel's own spacing and the
          capsule clearance: the search depth is a Workspace depth like any
          other, and its last hit must be able to scroll above the capsule
          (owner decision 2026-10-03). */}
      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--shell-space-3)] pb-[max(var(--shell-space-3),var(--workspace-content-bottom-inset,0px))]">
        <p className={cn('pb-[var(--shell-space-2)] uppercase tracking-wide text-muted-foreground', metadataAppClass)}>
          Files
        </p>
        {status === 'loading' ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-[var(--shell-session-row-radius)]" />
            ))}
          </div>
        ) : null}
        {status === 'error' ? (
          <div className="flex flex-col gap-2">
            <p className={cn('text-destructive', bodyAppClass)}>{error ?? 'Could not search files'}</p>
            <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => onRetry()}>
              Retry
            </Button>
          </div>
        ) : null}
        {status === 'ready' && query.trim().length > 0 && results.length === 0 ? (
          <p className={cn('text-muted-foreground', secondaryAppClass)}>
            {`No files match "${query.trim()}".`}
          </p>
        ) : null}
        {status === 'ready' ? (
          <ul className="flex flex-col gap-1">
            {results.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  data-testid={`files-search-result-${entry.path}`}
                  onClick={() => onSelectFile(entry)}
                  className="flex w-full min-h-[52px] flex-col justify-center rounded-[var(--shell-session-row-radius)] px-[var(--shell-space-2)] py-[var(--shell-space-2)] text-left hover:bg-muted/60"
                >
                  <span className={cn('truncate text-foreground', primaryAppClass)}>
                    {entry.name}
                  </span>
                  <span className={cn('truncate text-muted-foreground', chromeMonoRole('code'))}>
                    {entry.path}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
