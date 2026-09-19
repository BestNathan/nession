import { cn } from '@/shared/lib/utils';
import { useGitBranches } from '../hooks/useGitBranches';
import { describeUnavailable, formatBytes } from '../state';
import { GitNotice } from './GitNotice';
import type { GitBranch } from '../types';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';

/**
 * Branches — what else is here, and how far from where (#846).
 *
 * ## What this answers that the header does not
 *
 * The header already says which branch you are on and how far it is from *its*
 * upstream. It cannot say what other branches exist, or how each of those
 * stands against *its own* upstream — it does not know they are there. That is
 * the whole content here, which is why the current branch is marked rather than
 * left out: it is the anchor the other rows are read against, not a second copy
 * of the header.
 *
 * The one actionable fact it adds is **which branches carry unpushed work**,
 * which is what someone on a machine they are not sitting at wants to know.
 *
 * ## Why the rows say nothing when a branch is in sync
 *
 * `visual-language.md` P6: an up-to-date branch is a healthy state, not an
 * achievement. A row that reads `origin/feat/x` and stops has said everything
 * there is to say about it; a badge confirming it would be noise on the common
 * case, and noise on the common case is what makes the uncommon one invisible.
 */
export function GitBranchesView({ ctx }: { ctx: WorkspaceContext }) {
  const agentId = ctx.agent?.agent_id;
  const sessionId = ctx.session?.session_id;
  const { branches, loading, error } = useGitBranches({ agentId, sessionId });

  if (loading) {
    return <GitNotice testId="git-branches-loading">Reading branches…</GitNotice>;
  }
  if (error) {
    return (
      <GitNotice testId="git-branches-error" destructive>
        {error}
      </GitNotice>
    );
  }
  if (!branches) {
    return <GitNotice testId="git-branches-empty">No branches yet.</GitNotice>;
  }
  if (branches.state !== 'ok') {
    return (
      <div
        data-testid="git-branches-unavailable"
        data-state={branches.state}
        className="flex h-full min-h-0 items-center justify-center px-6 text-center"
      >
        <p className="max-w-sm text-sm text-muted-foreground">
          {describeUnavailable(branches).title}
        </p>
      </div>
    );
  }

  const { branches: rows, limit, truncated, truncatedBytes } = branches.branches;

  if (rows.length === 0) {
    // A repository with no commits has no branches. That is `git init` and
    // nothing else — a state, not a failure.
    return (
      <GitNotice testId="git-branches-none">
        This repository has no branches yet.
      </GitNotice>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-testid="git-branch-list" className="flex flex-col p-1">
        {rows.map((branch) => (
          <BranchRow key={branch.name} branch={branch} />
        ))}
        {rows.length >= limit ? (
          <p
            data-testid="git-branches-more"
            className="px-2 py-2 text-xs text-muted-foreground"
          >
            Showing {limit} of this repository&rsquo;s branches. The rest are not
            loaded.
          </p>
        ) : null}
        {truncated ? (
          <p
            data-testid="git-branches-truncated"
            className="px-2 py-2 text-xs text-muted-foreground"
          >
            Branch listing truncated — {formatBytes(truncatedBytes)} not read.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function BranchRow({ branch }: { branch: GitBranch }) {
  return (
    <div
      data-testid="git-branch-row"
      data-branch={branch.name}
      data-current={branch.current ? 'true' : undefined}
      className={cn(
        'flex flex-col gap-0.5 rounded-md px-2 py-1.5',
        branch.current && 'bg-accent text-accent-foreground',
      )}
    >
      <span className="flex items-center gap-1.5 text-sm">
        {/* The marker git itself prints, in the same place it prints it, so a
            list read here and a list read in a terminal agree line for line. */}
        {branch.current ? (
          <span
            data-testid="git-branch-current"
            className="shrink-0 font-mono text-muted-foreground"
            title="This is the branch the Session is on"
          >
            *
          </span>
        ) : null}
        <span className="truncate">{branch.name}</span>
      </span>
      <BranchTracking branch={branch} />
    </div>
  );
}

/**
 * The second line: what this branch is measured against, and how far off it is.
 *
 * Four states, and they are four different sentences — "in sync" and "tracks
 * nothing" arrive from the agent as identical counts, which is why `upstream`
 * being absent is the thing that separates them.
 */
function BranchTracking({ branch }: { branch: GitBranch }) {
  const parts: string[] = [];
  if (branch.upstream) {
    parts.push(branch.upstream);
  }
  if (branch.upstreamGone) {
    parts.push('upstream deleted');
  } else {
    if (branch.ahead > 0) {
      parts.push(`${branch.ahead} ahead`);
    }
    if (branch.behind > 0) {
      parts.push(`${branch.behind} behind`);
    }
  }

  if (!branch.upstream) {
    return (
      <span
        data-testid="git-branch-no-upstream"
        className="truncate text-xs text-muted-foreground"
      >
        No upstream
      </span>
    );
  }

  return (
    <span
      data-testid="git-branch-tracking"
      className="flex items-center gap-2 text-xs text-muted-foreground"
    >
      <span className="truncate">{parts.join(' · ')}</span>
    </span>
  );
}
