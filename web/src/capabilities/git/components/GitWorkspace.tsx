import { useMemo, useState } from 'react';
import { GitBranch, RefreshCw } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import { useGitStatus } from '../hooks/useGitStatus';
import {
  describeStatus,
  describeUnavailable,
  formatBytes,
  statusRows,
  worktreeName,
  type GitRow,
} from '../state';
import type { GitStatusResponse } from '../types';
import { useGitSelection, type GitSelectionState } from '../hooks/useGitSelection';
import { GitBranchesView } from './GitBranchesView';
import { GitChangeList } from './GitChangeList';
import { GitDiffView } from './GitDiffView';
import { GitFilePreviewView } from './GitFilePreviewView';
import { GitHistoryView } from './GitHistoryView';
import { GitNotice } from './GitNotice';
import { GitWorktreesView } from './GitWorktreesView';

/**
 * What the Git surface can show (`#826` §4).
 *
 * Everything on that list that is a **read**: the working tree, what happened
 * here, what other branches there are, and what other checkouts there are.
 * Staging and commit authoring are the write half and need their own decision —
 * `#750`'s Non-Goals drew the read-only boundary for a reason (#845).
 *
 * Four short, stable labels for the current context, which is the case
 * `workspace-navigation.md` allows segments in — this chooses what the
 * capability shows, and is not a second navigation shell.
 */
type GitSection = 'changes' | 'history' | 'branches' | 'worktrees';

/**
 * The file the entry said to open, if any (`#826`).
 *
 * The Terminal Peek hands over what the user picked there, and arriving on a
 * landing page instead would make them find it again — which is the context
 * loss the criterion exists to prevent.
 */
function focusedPath(ctx: WorkspaceContext): string | null {
  return ctx.focus?.capabilityId === 'git' ? (ctx.focus.resourceId ?? null) : null;
}

/**
 * Repository state for the current Session (#750), at the depth the Workspace
 * gives it (`#826` L3).
 *
 * Freshness is pull-on-open plus an explicit refresh — the shared
 * `useGitStatus` model — and the diff is fetched per file on selection.
 */
export function GitWorkspace({ ctx }: { ctx: WorkspaceContext }) {
  const agentId = ctx.agent?.agent_id;
  const sessionId = ctx.session?.session_id;
  const status = useGitStatus({ agentId, sessionId });
  const rows = useMemo(
    () => (status.status?.state === 'ok' ? statusRows(status.status.status) : null),
    [status.status],
  );
  const { state: selection, selectRow } = useGitSelection({
    agentId,
    sessionId,
    handedOver: focusedPath(ctx),
    rows,
  });
  const [section, setSection] = useState<GitSection>('changes');

  if (!sessionId) {
    return (
      <GitNotice testId="git-no-session">
        Select a Session to see the state of its repository.
      </GitNotice>
    );
  }

  return (
    <div data-testid="git-workspace" className="flex h-full min-h-0 flex-col">
      <GitHeader
        status={status.status}
        loading={status.loading}
        onRefresh={status.refresh}
        section={section}
        onSectionChange={setSection}
      />
      {/*
        Only the section that is showing is mounted. Its hook fetches on mount,
        so a hidden section would run its own command on the agent for a reader
        who never looked at it — a log, a ref listing, or a worktree listing
        nobody asked for.
      */}
      {section === 'history' ? (
        <GitHistoryView ctx={ctx} />
      ) : section === 'branches' ? (
        <GitBranchesView ctx={ctx} />
      ) : section === 'worktrees' ? (
        <GitWorktreesView ctx={ctx} />
      ) : (
        <GitBody status={status} rows={rows} selection={selection} onSelect={selectRow} />
      )}
    </div>
  );
}

function GitHeader({
  status,
  loading,
  onRefresh,
  section,
  onSectionChange,
}: {
  status: GitStatusResponse | null;
  loading: boolean;
  onRefresh: () => void;
  section: GitSection;
  onSectionChange: (section: GitSection) => void;
}) {
  const ok = status?.state === 'ok' ? status : null;
  const branch = ok?.status.detached ? 'Detached HEAD' : ok?.status.branch;
  const worktree = worktreeName(ok?.root);

  return (
    // `flex-wrap`, and the identity block carries a floor rather than
    // `min-w-0`. Four sections plus a branch name plus Refresh do not fit a
    // phone, and without a floor the name — the only item that *can* shrink —
    // absorbs all of it and disappears: measured at 390px it was 0px wide with
    // the header overflowing by 18px. Wrapping puts the sections on their own
    // row there and changes nothing wherever they already fit.
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
      <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-[8rem] flex-1">
        <p data-testid="git-branch" className={cn('truncate', chromeSansRole('primary'))}>
          {branch ?? 'Repository'}
        </p>
        <p data-testid="git-summary" className={cn('truncate text-muted-foreground', chromeSansRole('metadata'))}>
          {headerSummary(status, loading, worktree)}
        </p>
      </div>
      <Tabs
        value={section}
        onValueChange={(value) => onSectionChange(value as GitSection)}
        className="shrink-0"
      >
        <TabsList>
          <TabsTrigger value="changes">Changes</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="branches">Branches</TabsTrigger>
          <TabsTrigger value="worktrees">Worktrees</TabsTrigger>
        </TabsList>
      </Tabs>
      {/*
        Kept available while a read is in flight: a manual re-read is the
        recovery path, and the shared hook publishes only the latest-started
        read, so an overlapping refresh cannot regress the view (#2787). A
        disabled button here made the documented manual-refresh race
        unobservable on the real surface.
      */}
      <Button
        type="button"
        data-testid="git-refresh"
        variant="ghost"
        size="sm"
        aria-label="Refresh repository state"
        title="Refresh repository state"
        onClick={() => onRefresh()}
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </header>
  );
}

/**
 * The header's second line.
 *
 * Names the work tree as well as the branch: the same repository checked out
 * twice is two different places to be, and the Peek already says which one
 * (`capability-emergence.md` lists worktree identity as part of the model).
 */
function headerSummary(
  status: GitStatusResponse | null,
  loading: boolean,
  worktree: string | null,
): string {
  if (loading) {
    return 'Reading repository…';
  }
  if (!status) {
    return '';
  }
  if (status.state !== 'ok') {
    return describeUnavailable(status).title;
  }
  const parts = [describeStatus(status.status), worktree && `worktree: ${worktree}`];
  let summary = parts.filter(Boolean).join(' · ');
  if (status.truncated) {
    // A partial listing presented as a whole one is the failure C3 names; the
    // count is the first thing that would be wrong, so it says so here.
    summary += ` — listing truncated, ${formatBytes(status.truncatedBytes)} not read`;
  }
  return summary;
}

function GitBody({
  status,
  rows,
  selection,
  onSelect,
}: {
  status: ReturnType<typeof useGitStatus>;
  rows: readonly GitRow[] | null;
  selection: GitSelectionState;
  onSelect: (row: GitRow) => void;
}) {
  if (status.loading) {
    return <GitNotice testId="git-loading">Reading repository state…</GitNotice>;
  }
  if (status.error) {
    return (
      <GitNotice testId="git-transport-error" destructive>
        {status.error}
      </GitNotice>
    );
  }
  if (!status.status) {
    return <GitNotice testId="git-empty">No repository state yet.</GitNotice>;
  }
  if (status.status.state !== 'ok') {
    const copy = describeUnavailable(status.status);
    return (
      <div
        data-testid="git-unavailable"
        data-state={status.status.state}
        className="flex h-full min-h-0 items-center justify-center px-6 text-center"
      >
        <div className="max-w-sm space-y-1.5">
          <p className={cn('text-foreground', chromeSansRole('secondary'))}>{copy.title}</p>
          {copy.detail ? <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>{copy.detail}</p> : null}
        </div>
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    // A clean tree is healthy, so it says so plainly and offers nothing —
    // `visual-language.md` P6. And with nothing to open, the diff pane has no
    // subject: the layout drops rather than sitting there empty.
    return (
      <GitNotice testId="git-clean">Nothing has changed since the last commit.</GitNotice>
    );
  }

  // Side by side when there is room, stacked when there is not. The breakpoint
  // is about available width, not about the experience: a phone in a desktop
  // browser has the same problem as an App, and a tablet has neither's room.
  //
  // Stacked, the list is capped at half the pane so the diff it opened stays on
  // screen — a repository with fifty changed files must not push the file the
  // user just picked out of view. A flex column rather than a grid, because the
  // cap is a share of the pane and a percentage inside an auto-sized grid row
  // resolves against that row, which is the thing being sized.
  return (
    <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(12rem,20rem)_minmax(0,1fr)]">
      <aside className={cn('max-h-[50%] min-h-0 shrink-0 overflow-y-auto border-b lg:max-h-none lg:shrink lg:border-b-0 lg:border-r', workspaceScrollClearanceClass)}>
        <GitChangeList rows={rows} selectedPath={selection.selectedPath} onSelect={onSelect} />
      </aside>
      <main className="flex min-h-0 flex-1 flex-col lg:flex-none">
        {selection.mode === 'preview' ? (
          <GitFilePreviewView
            path={selection.selectedPath}
            expected={selection.previewKind ?? 'untracked'}
            response={selection.preview}
            loading={selection.loading}
            error={selection.error}
          />
        ) : (
          <GitDiffView response={selection.diff} loading={selection.loading} error={selection.error} />
        )}
      </main>
    </div>
  );
}

