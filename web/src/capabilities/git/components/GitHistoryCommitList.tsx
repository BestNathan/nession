import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { WorkspaceBoundedScrollport } from '@/components/ui/workspace-scrollport';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { formatBytes } from '../state';
import type { GitCommit } from '../types';

export function GitHistoryCommitList({
  commits,
  limit,
  truncated,
  truncatedBytes,
  selected,
  endOfHistory,
  nextCursor,
  loadingMore,
  olderError,
  onSelect,
  onLoadOlder,
  onRefresh,
}: {
  commits: GitCommit[];
  limit: number;
  truncated: boolean;
  truncatedBytes: number;
  selected: string | null;
  endOfHistory: boolean;
  nextCursor: string | null;
  loadingMore: boolean;
  olderError: string | null;
  onSelect: (hash: string) => void;
  onLoadOlder: () => void;
  onRefresh: () => void;
}) {
  return (
    <WorkspaceBoundedScrollport
      role="complementary"
      viewportClassName="max-h-[50%] flex-none border-b lg:max-h-none lg:shrink lg:border-b-0 lg:border-r"
    >
      <div data-testid="git-commit-list" className="flex flex-col p-[var(--nession-shell-space-1)]">
        {/* #4455 demand-only: the manual re-read of the history listing, visible
            rather than sr-only. No interval or watcher is added. */}
        <div className="flex shrink-0 items-center justify-end px-[var(--nession-shell-space-1)] pb-[var(--nession-shell-space-1)]">
          <RefreshButton
            onClick={() => onRefresh()}
            variant="ghost"
            ariaLabel="Refresh"
          />
        </div>
        {commits.map((commit) => (
          <CommitRow
            key={commit.hash}
            commit={commit}
            selected={commit.hash === selected}
            onSelect={onSelect}
          />
        ))}
        {!endOfHistory && nextCursor ? (
          <>
            <button
              type="button"
              data-testid="git-history-load-more"
              disabled={loadingMore}
              onClick={onLoadOlder}
              className={cn(
                'mx-[var(--nession-shell-space-2)] my-[var(--nession-shell-space-2)] rounded-[var(--nession-radius-control)] px-[var(--nession-shell-space-2)] py-[var(--nession-shell-space-1)] text-left text-primary hover:bg-accent',
                chromeSansRole('metadata'),
              )}
            >
              {loadingMore ? 'Loading older commits…' : 'Load older commits'}
            </button>
            {olderError ? (
              <p
                data-testid="git-history-older-error"
                role="alert"
                className={cn('mx-[var(--nession-shell-space-2)] my-[var(--nession-shell-space-1)] text-destructive', chromeSansRole('metadata'))}
              >
                {olderError}
              </p>
            ) : null}
          </>
        ) : null}
        {commits.length >= limit && endOfHistory ? (
          <p data-testid="git-history-more" className={cn('px-[var(--nession-shell-space-2)] py-[var(--nession-shell-space-2)] text-muted-foreground', chromeSansRole('metadata'))}>
            End of history — {commits.length} commit{commits.length === 1 ? '' : 's'} loaded.
          </p>
        ) : null}
        {truncated ? (
          <p data-testid="git-history-truncated" className={cn('px-[var(--nession-shell-space-2)] py-[var(--nession-shell-space-2)] text-muted-foreground', chromeSansRole('metadata'))}>
            History truncated — {formatBytes(truncatedBytes)} not read.
          </p>
        ) : null}
      </div>
    </WorkspaceBoundedScrollport>
  );
}

function CommitRow({
  commit,
  selected,
  onSelect,
}: {
  commit: GitCommit;
  selected: boolean;
  onSelect: (hash: string) => void;
}) {
  return (
    <button
      type="button"
      data-testid="git-commit-row"
      data-hash={commit.hash}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(commit.hash)}
      className={cn(
        'flex flex-col gap-[var(--nession-shell-space-1)] rounded-[var(--nession-radius-control)] px-[var(--nession-shell-space-2)] py-[var(--nession-shell-space-1)] text-left transition-colors',
        'hover:bg-accent hover:text-accent-foreground focus-visible:outline-solid focus-visible:outline-[length:var(--nession-focus-ring-width)] focus-visible:outline-ring focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))]',
        selected && 'bg-accent text-accent-foreground',
      )}
    >
      <span className={cn('truncate', chromeSansRole('secondary'))}>{commit.subject}</span>
      <span className={cn('flex items-center gap-[var(--nession-shell-space-2)] text-muted-foreground', chromeSansRole('metadata'))}>
        <span className="font-mono">{commit.short_hash}</span>
        <span className="truncate">{commit.author}</span>
        <span className="shrink-0">{commit.relative_date}</span>
      </span>
    </button>
  );
}
