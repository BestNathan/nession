import { useState } from 'react';
import { cn } from '@/shared/lib/utils';
import { useGitHistory } from '../hooks/useGitHistory';
import { describeUnavailable, formatBytes } from '../state';
import { GitNotice } from './GitNotice';
import type { GitCommit } from '../types';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';

/**
 * History — what happened here recently (`#826` §4).
 *
 * Read-only, like the rest of the capability: `git log` answers the same kind of
 * question as `git status`, and #750 left it out for scope rather than for risk.
 *
 * ## What this deliberately is not
 *
 * It is not a patch browser. Selecting a commit shows *which* commit it is —
 * full hash, author, when, what it is called — and not what it changed; a commit
 * patch is a diff of unknown size and belongs with the rest of the large-surface
 * work rather than here. Saying so on the screen is cheaper than a reader
 * concluding the absence is a bug.
 *
 * The list is what answers the question people actually bring to a log: what has
 * been happening, and does anything here look like mine.
 */
export function GitHistoryView({ ctx }: { ctx: WorkspaceContext }) {
  const agentId = ctx.agent?.agent_id;
  const sessionId = ctx.session?.session_id;
  // Mounted only when this section is showing, so mounting *is* the request —
  // the Git view keeps it unmounted otherwise and the agent runs no log.
  const { history, loading, error } = useGitHistory({ agentId, sessionId });
  const [selected, setSelected] = useState<string | null>(null);

  if (loading) {
    return <GitNotice testId="git-history-loading">Reading history…</GitNotice>;
  }
  if (error) {
    return (
      <GitNotice testId="git-history-error" destructive>
        {error}
      </GitNotice>
    );
  }
  if (!history) {
    return <GitNotice testId="git-history-empty">No history yet.</GitNotice>;
  }
  if (history.state !== 'ok') {
    return (
      <div
        data-testid="git-history-unavailable"
        data-state={history.state}
        className="flex h-full min-h-0 items-center justify-center px-6 text-center"
      >
        <p className="max-w-sm text-sm text-muted-foreground">
          {describeUnavailable(history).title}
        </p>
      </div>
    );
  }

  const { commits, limit, truncated, truncatedBytes } = history.history;
  const selectedCommit = commits.find((commit) => commit.hash === selected) ?? null;

  if (commits.length === 0) {
    // A repository with no commits is a real state — `git init` and nothing
    // else — and it is not an error.
    return (
      <GitNotice testId="git-history-none">
        This repository has no commits yet.
      </GitNotice>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(14rem,22rem)_minmax(0,1fr)]">
      <aside className="max-h-[50%] min-h-0 shrink-0 overflow-y-auto border-b lg:max-h-none lg:shrink lg:border-b-0 lg:border-r">
        <div data-testid="git-commit-list" className="flex flex-col p-1">
          {commits.map((commit) => (
            <CommitRow
              key={commit.hash}
              commit={commit}
              selected={commit.hash === selected}
              onSelect={setSelected}
            />
          ))}
          {commits.length >= limit ? (
            <p
              data-testid="git-history-more"
              className="px-2 py-2 text-xs text-muted-foreground"
            >
              Showing the most recent {limit}. Older commits are not loaded.
            </p>
          ) : null}
          {truncated ? (
            // Same rule as the diff and the listing: a partial answer says so.
            <p data-testid="git-history-truncated" className="px-2 py-2 text-xs text-muted-foreground">
              History truncated — {formatBytes(truncatedBytes)} not read.
            </p>
          ) : null}
        </div>
      </aside>
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-none">
        <CommitDetail commit={selectedCommit} />
      </main>
    </div>
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
        'flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
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

function CommitDetail({ commit }: { commit: GitCommit | null }) {
  if (!commit) {
    return (
      <p data-testid="git-commit-empty" className="p-4 text-sm text-muted-foreground">
        Select a commit to see which one it is.
      </p>
    );
  }

  return (
    <div data-testid="git-commit-detail" className="flex flex-col gap-3 p-4">
      <p className="text-sm font-medium">{commit.subject}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Commit</dt>
        <dd className="truncate font-mono" title={commit.hash}>
          {commit.hash}
        </dd>
        <dt className="text-muted-foreground">Author</dt>
        <dd className="truncate">{commit.author}</dd>
        <dt className="text-muted-foreground">Date</dt>
        <dd className="truncate" title={commit.date}>
          {commit.relativeDate}
        </dd>
        {commit.refs ? (
          <>
            <dt className="text-muted-foreground">Refs</dt>
            <dd className="truncate">{commit.refs}</dd>
          </>
        ) : null}
      </dl>
      <p className="text-xs text-muted-foreground">
        What this commit changed is not shown here.
      </p>
    </div>
  );
}
