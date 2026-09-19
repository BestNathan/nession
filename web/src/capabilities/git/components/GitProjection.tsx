import { useGitStatus } from '../hooks/useGitStatus';
import {
  changeLetter,
  describeStatus,
  describeUnavailable,
  basename,
  stagedSplit,
  worktreeName,
} from '../state';
import type { GitStatus } from '../types';

/**
 * What Git says about itself in the Terminal, at the depth Nession chose.
 *
 * Only the body. The frame — title, dismissal, and the path into Workspace —
 * belongs to the capsule, because those are Nession's decisions about
 * placement, not Git's about content (`workspace-navigation.md`: "Extensions
 * contribute capability. Nession decides whether, where, and how").
 *
 * Both depths read the same `useGitStatus`, so a Signal and the Peek opened
 * from it cannot report different repositories.
 */
export function GitProjection({
  agentId,
  sessionId,
  depth,
  onFocusChange,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  depth: 'signal' | 'peek';
  onFocusChange?: (resourceId?: string) => void;
}) {
  const { status, loading, error } = useGitStatus({ agentId, sessionId });

  // A Signal that cannot say anything is not worth the space it takes from the
  // work surface. The failure states have readable copy in the Workspace, which
  // is where someone can act on them (`capability-emergence.md`: a Signal is
  // "the smallest identifying state needed").
  if (loading) {
    return <p className="text-xs text-muted-foreground">Reading repository…</p>;
  }
  if (error || !status) {
    return <p className="text-xs text-muted-foreground">{error ?? 'Repository unavailable'}</p>;
  }
  if (status.state !== 'ok') {
    return <p className="text-xs text-muted-foreground">{describeUnavailable(status).title}</p>;
  }

  return depth === 'signal' ? (
    <GitSignalBody status={status.status} root={status.root} />
  ) : (
    <GitPeekBody status={status.status} root={status.root} onFocusChange={onFocusChange} />
  );
}

/**
 * L1 — the smallest identifying state.
 *
 * Branch, where the work tree is, and how far it has drifted. Not a toolbar and
 * not a list of actions.
 */
function GitSignalBody({ status, root }: { status: GitStatus; root: string }) {
  const worktree = worktreeName(root);
  const identity = [status.detached ? 'Detached HEAD' : status.branch, worktree && `worktree: ${worktree}`]
    .filter(Boolean)
    .join(' · ');

  return (
    <div data-testid="git-signal-body" className="flex flex-col gap-0.5">
      <p className="truncate text-xs font-medium text-foreground">{identity}</p>
      <p className="truncate text-xs text-muted-foreground">{describeStatus(status)}</p>
    </div>
  );
}

const PEEK_FILES = 4;

/**
 * L2 — what is happening here, and is it worth going deeper.
 *
 * "Peek may show a short changed-file summary because those files explain the
 * current state. It should not render a full diff, commit graph, branch
 * manager, or history browser." The list is capped at {@link PEEK_FILES} for
 * that reason, and counting the remainder is more honest than silently showing
 * the first few.
 *
 * Picking a file sets the focus the frame's Workspace handoff carries, so the
 * transition lands on that file's diff rather than a Git landing page.
 */
function GitPeekBody({
  status,
  root,
  onFocusChange,
}: {
  status: GitStatus;
  root: string;
  onFocusChange?: (resourceId?: string) => void;
}) {
  const worktree = worktreeName(root);
  const { staged, unstaged } = stagedSplit(status);
  const rows = [
    ...status.unmerged.map((path) => ({ path, kind: 'unmerged' as const })),
    ...status.modified,
    ...status.untracked.map((path) => ({ path, kind: 'untracked' as const })),
  ];
  const shown = rows.slice(0, PEEK_FILES);
  const rest = rows.length - shown.length;

  return (
    <div data-testid="git-peek-body" className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <p className="truncate text-xs text-muted-foreground">
          {status.detached ? 'Detached HEAD' : status.branch}
          {worktree ? ` · worktree: ${worktree}` : ''}
        </p>
        <p className="truncate text-xs text-foreground">{describeStatus(status)}</p>
        {status.modified.length > 0 ? (
          <p className="truncate text-xs text-muted-foreground">
            {staged} staged · {unstaged} unstaged
          </p>
        ) : null}
      </div>

      {shown.length > 0 ? (
        <ul data-testid="git-peek-files" className="flex flex-col gap-0.5">
          {shown.map((row) => (
            <li key={`${row.kind}:${row.path}`}>
              <button
                type="button"
                data-testid="git-peek-file"
                data-path={row.path}
                title={row.path}
                onClick={() => onFocusChange?.(row.path)}
                className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="w-3 shrink-0 font-mono">
                  {row.kind === 'untracked' ? '?' : changeLetter(row.kind)}
                </span>
                <span className="truncate">{basename(row.path)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {rest > 0 ? (
        <p data-testid="git-peek-more" className="text-xs text-muted-foreground">
          and {rest} more
        </p>
      ) : null}
    </div>
  );
}
