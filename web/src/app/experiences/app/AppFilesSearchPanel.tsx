import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { FileEntry } from '@/capabilities/files';
import type { AppFilesSearchStatus } from './useAppFilesSearch';
import { cn } from '@/shared/lib/utils';
import { workspaceBoundedScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import { bodyAppClass, primaryAppClass, secondaryAppClass } from '@/app/experiences/app/appTypography';
import { chromeLabelRole, chromeMonoRole } from '@/shared/typography/chromeRoles';

export interface AppFilesSearchPanelProps {
  query: string;
  onQueryChange: (value: string) => void;
  status: AppFilesSearchStatus;
  error: string | null;
  results: FileEntry[];
  /** True when the scan stopped before covering the whole Workspace. */
  incomplete: boolean;
  onSelectFile: (entry: FileEntry) => void;
  onRetry: () => void;
}

export function AppFilesSearchPanel({
  query,
  onQueryChange,
  status,
  error,
  results,
  incomplete,
  onSelectFile,
  onRetry,
}: AppFilesSearchPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="files-app-search">
      <div className="relative shrink-0 px-[var(--nession-shell-space-3)] pb-[var(--nession-shell-space-2)]">
        <Search
          className="pointer-events-none absolute left-[calc(var(--nession-shell-space-3)+0.75rem)] top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
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
      {/* The search depth is a bounded surface inside Files (#4115): its hit
          list is the internal scroll owner and spends the host's measured
          trailing inset, so the last hit can scroll above the Capsule without
          the panel computing that geometry itself. */}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-[var(--nession-shell-space-3)]',
          workspaceBoundedScrollClearanceClass,
        )}
      >
        <p className={cn('pb-[var(--nession-shell-space-2)] text-muted-foreground', chromeLabelRole())}>
          Files
        </p>
        {status === 'ready' && incomplete ? (
          <p
            className={cn('pb-[var(--nession-shell-space-2)] text-muted-foreground', secondaryAppClass)}
            data-testid="files-search-incomplete"
          >
            Showing partial results — this Workspace was not scanned completely.
          </p>
        ) : null}
        {status === 'loading' ? (
          <div className="flex flex-col gap-2" data-testid="files-search-loading">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-[var(--nession-shell-session-row-radius)]" />
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
          <p
            className={cn('text-muted-foreground', secondaryAppClass)}
            data-testid="files-search-empty"
          >
            {incomplete
              ? `No files match "${query.trim()}" in the scanned part of this Workspace.`
              : `No files match "${query.trim()}".`}
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
                  className="flex w-full min-h-[52px] flex-col justify-center rounded-[var(--nession-shell-session-row-radius)] px-[var(--nession-shell-space-2)] py-[var(--nession-shell-space-2)] text-left hover:bg-muted/60"
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
