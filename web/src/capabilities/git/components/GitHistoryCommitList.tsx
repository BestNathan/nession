import { cn } from '@/shared/lib/utils';
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
  onSelect: (hash: string) => void;
  onLoadOlder: () => void;
  onRefresh: () => void;
}) {
  return (
    <aside className="max-h-[50%] min-h-0 shrink-0 overflow-y-auto border-b lg:max-h-none lg:shrink lg:border-b-0 lg:border-r">
      <div data-testid="git-commit-list" className="flex flex-col p-1">
        {commits.map((commit) => (
          <CommitRow
            key={commit.hash}
            commit={commit}
            selected={commit.hash === selected}
            onSelect={onSelect}
          />
        ))}
        {!endOfHistory && nextCursor ? (
          <button
            type="button"
            data-testid="git-history-load-more"
            disabled={loadingMore}
            onClick={onLoadOlder}
            className="mx-2 my-2 rounded-[var(--radius-control)] px-2 py-1.5 text-left text-xs text-primary hover:bg-accent"
          >
            {loadingMore ? 'Loading older commits…' : 'Load older commits'}
          </button>
        ) : null}
        {commits.length >= limit && endOfHistory ? (
          <p data-testid="git-history-more" className="px-2 py-2 text-xs text-muted-foreground">
            End of history — {commits.length} commit{commits.length === 1 ? '' : 's'} loaded.
          </p>
        ) : null}
        {truncated ? (
          <p data-testid="git-history-truncated" className="px-2 py-2 text-xs text-muted-foreground">
            History truncated — {formatBytes(truncatedBytes)} not read.
          </p>
        ) : null}
        <button type="button" className="sr-only" onClick={onRefresh}>
          Refresh
        </button>
      </div>
    </aside>
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
        'flex flex-col gap-0.5 rounded-[var(--radius-control)] px-2 py-1.5 text-left transition-colors',
        'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'bg-accent text-accent-foreground',
      )}
    >
      <span className="truncate text-sm">{commit.subject}</span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{commit.shortHash}</span>
        <span className="truncate">{commit.author}</span>
        <span className="shrink-0">{commit.relativeDate}</span>
      </span>
    </button>
  );
}
