import { useCallback, useEffect, useRef, useState } from 'react';
import { GitBranch, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import { gitApi } from '../GitPlugin';
import { useGitStatus } from '../hooks/useGitStatus';
import {
  describeStatus,
  describeUnavailable,
  formatBytes,
  statusRows,
  worktreeName,
} from '../state';
import type { GitDiffResponse, GitStatusResponse } from '../types';
import { GitBranchesView } from './GitBranchesView';
import { GitChangeList } from './GitChangeList';
import { GitDiffView } from './GitDiffView';
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

interface GitDiffState {
  selectedPath: string | null;
  diff: GitDiffResponse | null;
  diffLoading: boolean;
  diffError: string | null;
}

const NO_DIFF: GitDiffState = {
  selectedPath: null,
  diff: null,
  diffLoading: false,
  diffError: null,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not reach the agent';
}

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

function useGitDiff(ctx: WorkspaceContext) {
  const agentId = ctx.agent?.agent_id;
  const sessionId = ctx.session?.session_id;
  const [state, setState] = useState<GitDiffState>(NO_DIFF);

  // One request per opened file, and a response is dropped when the Session
  // moved on or the user has since picked something else.
  const generation = useRef(0);
  const target = useRef<{ agent_id: string; session: string } | null>(null);

  const selectFile = useCallback(async (path: string) => {
    const current = target.current;
    if (!current) {
      return;
    }
    const forGeneration = generation.current;
    setState({ selectedPath: path, diff: null, diffLoading: true, diffError: null });
    try {
      const response = await gitApi.gitDiff({ ...current, path });
      if (generation.current !== forGeneration) {
        return;
      }
      setState((previous) =>
        previous.selectedPath === path
          ? { selectedPath: path, diff: response, diffLoading: false, diffError: null }
          : previous,
      );
    } catch (error) {
      if (generation.current !== forGeneration) {
        return;
      }
      setState((previous) =>
        previous.selectedPath === path
          ? { ...previous, diffLoading: false, diffError: message(error) }
          : previous,
      );
    }
  }, []);

  // Read out here rather than inside the effect: `ctx` is rebuilt on every
  // render, so depending on it would re-run this without anything changing.
  const handedOver = focusedPath(ctx);

  useEffect(() => {
    generation.current += 1;
    target.current = agentId && sessionId ? { agent_id: agentId, session: sessionId } : null;
    setState(NO_DIFF);
    if (target.current && handedOver) {
      void selectFile(handedOver);
    }
  }, [agentId, sessionId, handedOver, selectFile]);

  return { state, selectFile };
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
  const { state: diff, selectFile } = useGitDiff(ctx);
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
        <GitBody status={status} diff={diff} onSelect={selectFile} />
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
        <p data-testid="git-branch" className="truncate text-sm font-medium">
          {branch ?? 'Repository'}
        </p>
        <p data-testid="git-summary" className="truncate text-xs text-muted-foreground">
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
      <Button
        type="button"
        data-testid="git-refresh"
        variant="ghost"
        size="sm"
        disabled={loading}
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
 * twice is two different places to be, and the Signal already says which one
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
  diff,
  onSelect,
}: {
  status: ReturnType<typeof useGitStatus>;
  diff: GitDiffState;
  onSelect: (path: string) => void;
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
          <p className="text-sm font-medium text-foreground">{copy.title}</p>
          {copy.detail ? <p className="text-xs text-muted-foreground">{copy.detail}</p> : null}
        </div>
      </div>
    );
  }

  const rows = statusRows(status.status.status);
  if (rows.length === 0) {
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
      <aside className="max-h-[50%] min-h-0 shrink-0 overflow-y-auto border-b lg:max-h-none lg:shrink lg:border-b-0 lg:border-r">
        <GitChangeList rows={rows} selectedPath={diff.selectedPath} onSelect={onSelect} />
      </aside>
      <main className="flex min-h-0 flex-1 flex-col lg:flex-none">
        <GitDiffView response={diff.diff} loading={diff.diffLoading} error={diff.diffError} />
      </main>
    </div>
  );
}

