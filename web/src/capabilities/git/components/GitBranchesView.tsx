import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { WorkspaceBoundedScrollport } from '@/components/ui/workspace-scrollport';
import { RefreshButton } from '@/components/ui/RefreshButton';
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
  const { branches, loading, error, refresh } = useGitBranches({ agentId, sessionId });

  // #4455 demand-only: this section reads on open and on an explicit refresh —
  // the toolbar below is the manual entry, never an interval or watcher.
  let body: ReactNode;
  if (loading) {
    body = <GitNotice testId="git-branches-loading">Reading branches…</GitNotice>;
  } else if (error) {
    body = (
      <GitNotice testId="git-branches-error" destructive>
        {error}
      </GitNotice>
    );
  } else if (!branches) {
    body = <GitNotice testId="git-branches-empty">No branches yet.</GitNotice>;
  } else if (branches.state !== 'ok') {
    body = (
      <div
        data-testid="git-branches-unavailable"
        data-state={branches.state}
        className="flex h-full min-h-0 items-center justify-center px-[var(--nession-shell-space-5)] text-center"
      >
        <p className={cn('max-w-sm text-muted-foreground', chromeSansRole('secondary'))}>
          {describeUnavailable(branches).title}
        </p>
      </div>
    );
  } else if (branches.branches.branches.length === 0) {
    // A repository with no commits has no branches. That is `git init` and
    // nothing else — a state, not a failure.
    body = (
      <GitNotice testId="git-branches-none">
        This repository has no branches yet.
      </GitNotice>
    );
  } else {
    const { branches: rows, limit, truncated, truncated_bytes } = branches.branches;
    body = (
      /* #4188: the Branches section is a declared `bounded` App surface
         (GitWorkspace), so this list is the internal scroll owner. It spends
         the host-measured inset here instead of leaving a long ref listing
         clipped by the bounded region with no way to reach its end. */
      <WorkspaceBoundedScrollport
        data-testid="git-branch-list"
        viewportClassName="flex flex-col"
        className="p-[var(--nession-shell-space-1)]"
      >
        {rows.map((branch) => (
          <BranchRow key={branch.name} branch={branch} />
        ))}
        {rows.length >= limit ? (
          <p
            data-testid="git-branches-more"
            className={cn('px-[var(--nession-shell-space-2)] py-[var(--nession-shell-space-2)] text-muted-foreground', chromeSansRole('metadata'))}
          >
            Showing {limit} of this repository&rsquo;s branches. The rest are not
            loaded.
          </p>
        ) : null}
        {truncated ? (
          <p
            data-testid="git-branches-truncated"
            className={cn('px-[var(--nession-shell-space-2)] py-[var(--nession-shell-space-2)] text-muted-foreground', chromeSansRole('metadata'))}
          >
            Branch listing truncated — {formatBytes(truncated_bytes)} not read.
          </p>
        ) : null}
      </WorkspaceBoundedScrollport>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-end border-b px-[var(--nession-shell-space-2)] py-[var(--nession-shell-space-1)]">
        <RefreshButton
          onClick={() => refresh()}
          variant="ghost"
          ariaLabel="Refresh branches"
        />
      </div>
      {body}
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
        'flex flex-col gap-[var(--nession-rhythm-fact-stack)] rounded-[var(--nession-radius-surface)] px-[var(--nession-shell-space-2)] py-[var(--nession-rhythm-field-stack)]',
        branch.current && 'bg-accent text-accent-foreground',
      )}
    >
      <span className={cn('flex items-center gap-[var(--nession-rhythm-field-stack)]', chromeSansRole('secondary'))}>
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
  // First, because it is the case the counts cannot express: no upstream and a
  // level branch both arrive as zero and zero.
  if (!branch.upstream) {
    return (
      <span
        data-testid="git-branch-no-upstream"
        className={cn('truncate text-muted-foreground', chromeSansRole('metadata'))}
      >
        No upstream
      </span>
    );
  }

  const parts = [branch.upstream];
  if (branch.upstream_gone) {
    parts.push('upstream deleted');
  } else {
    if (branch.ahead > 0) {
      parts.push(`${branch.ahead} ahead`);
    }
    if (branch.behind > 0) {
      parts.push(`${branch.behind} behind`);
    }
  }

  return (
    <span
      data-testid="git-branch-tracking"
      className={cn('truncate text-muted-foreground', chromeSansRole('metadata'))}
    >
      {parts.join(' · ')}
    </span>
  );
}
