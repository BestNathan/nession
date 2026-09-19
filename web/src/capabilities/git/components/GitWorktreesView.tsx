import { cn } from '@/shared/lib/utils';
import { useGitWorktrees } from '../hooks/useGitWorktrees';
import { basename, describeUnavailable, formatBytes } from '../state';
import { GitNotice } from './GitNotice';
import type { GitWorktree } from '../types';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';

/**
 * Worktrees — the repository's other checkouts, and this one (#846).
 *
 * ## Identity versus inventory
 *
 * The header already says *which checkout this Session is in*, and the Terminal
 * Signal says it before that. This answers a question neither can: *what other
 * places does this repository have*. The Session's own entry is therefore
 * marked, so the two agree instead of competing — and the row is not a control,
 * because moving the Session to another checkout is a Session action and this
 * capability does not take those (`#750` Non-Goals).
 *
 * ## The basename leads, the address is on hover
 *
 * Same rule as the header's `worktree: capsule`: a person recognises a checkout
 * by the directory they call it, not by its path, and `…/worktrees/capsule` and
 * `…/wt/capsule` are the same word in the same place. The full path is the
 * title, so the address is one hover away rather than gone.
 */
export function GitWorktreesView({ ctx }: { ctx: WorkspaceContext }) {
  const agentId = ctx.agent?.agent_id;
  const sessionId = ctx.session?.session_id;
  const { worktrees, loading, error } = useGitWorktrees({ agentId, sessionId });

  if (loading) {
    return <GitNotice testId="git-worktrees-loading">Reading worktrees…</GitNotice>;
  }
  if (error) {
    return (
      <GitNotice testId="git-worktrees-error" destructive>
        {error}
      </GitNotice>
    );
  }
  if (!worktrees) {
    return <GitNotice testId="git-worktrees-empty">No worktrees yet.</GitNotice>;
  }
  if (worktrees.state !== 'ok') {
    return (
      <div
        data-testid="git-worktrees-unavailable"
        data-state={worktrees.state}
        className="flex h-full min-h-0 items-center justify-center px-6 text-center"
      >
        <p className="max-w-sm text-sm text-muted-foreground">
          {describeUnavailable(worktrees).title}
        </p>
      </div>
    );
  }

  const { worktrees: rows, truncated, truncatedBytes } = worktrees.worktrees;

  if (rows.length === 0) {
    // `git worktree list` always reports at least the repository itself, so an
    // empty answer is not a state git produces — say so rather than render an
    // empty frame that reads as "still loading".
    return (
      <GitNotice testId="git-worktrees-none">
        This repository did not report any worktrees.
      </GitNotice>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-testid="git-worktree-list" className="flex flex-col p-1">
        {rows.map((worktree) => (
          <WorktreeRow key={worktree.path} worktree={worktree} />
        ))}
        {truncated ? (
          <p
            data-testid="git-worktrees-truncated"
            className="px-2 py-2 text-xs text-muted-foreground"
          >
            Worktree listing truncated — {formatBytes(truncatedBytes)} not read.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function WorktreeRow({ worktree }: { worktree: GitWorktree }) {
  return (
    <div
      data-testid="git-worktree-row"
      data-path={worktree.path}
      data-current={worktree.current ? 'true' : undefined}
      title={worktree.path}
      className={cn(
        'flex flex-col gap-0.5 rounded-md px-2 py-1.5',
        worktree.current && 'bg-accent text-accent-foreground',
      )}
    >
      <span className="flex items-center gap-1.5 text-sm">
        {worktree.current ? (
          <span
            data-testid="git-worktree-current"
            className="shrink-0 font-mono text-muted-foreground"
            title="This is the checkout the Session is in"
          >
            *
          </span>
        ) : null}
        <span className="truncate">{basename(worktree.path)}</span>
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {describeWorktree(worktree)}
      </span>
      {worktree.locked !== undefined ? (
        <span
          data-testid="git-worktree-locked"
          className="truncate text-xs text-muted-foreground"
        >
          Locked{worktree.locked ? ` — ${worktree.locked}` : ''}
        </span>
      ) : null}
      {worktree.prunable !== undefined ? (
        // Said out loud because the alternative is a row naming a directory
        // that is not there, which reads as a place the user could go.
        <span
          data-testid="git-worktree-prunable"
          className="truncate text-xs text-muted-foreground"
        >
          The directory is gone — git still holds this entry until it is pruned.
        </span>
      ) : null}
    </div>
  );
}

/** What is checked out there, in the words that fit the state. */
function describeWorktree(worktree: GitWorktree): string {
  if (worktree.bare) {
    return 'Bare repository — no working tree';
  }
  if (worktree.detached) {
    return 'Detached HEAD';
  }
  return worktree.branch ?? 'No branch reported';
}
