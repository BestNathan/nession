import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { GitBranch, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import { gitApi } from '../GitPlugin';
import { describeStatus, describeUnavailable, formatBytes, statusRows } from '../state';
import type { GitDiffResponse, GitStatusResponse } from '../types';
import { GitChangeList } from './GitChangeList';
import { GitDiffView } from './GitDiffView';

interface GitWorkspaceState {
  status: GitStatusResponse | null;
  loading: boolean;
  /** A transport failure — distinct from a state the agent answered with. */
  error: string | null;
  selectedPath: string | null;
  diff: GitDiffResponse | null;
  diffLoading: boolean;
  diffError: string | null;
}

const INITIAL: GitWorkspaceState = {
  status: null,
  loading: true,
  error: null,
  selectedPath: null,
  diff: null,
  diffLoading: false,
  diffError: null,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not reach the agent';
}

/**
 * Repository state for the current Session (#750).
 *
 * Freshness is pull-on-open plus an explicit refresh (the model the issue's
 * Open Question 3 recommends, and the one `claude_code.list` already uses):
 * this asks when the Session changes and when the user asks, and never polls.
 * The repository is resolved agent-side from the Session's live working
 * directory each time, so a `cd` inside the Session is picked up by the next
 * request rather than needing to be pushed.
 */
function useGitWorkspace(ctx: WorkspaceContext) {
  const agentId = ctx.agent?.agent_id;
  const sessionId = ctx.session?.session_id;
  const [state, setState] = useState<GitWorkspaceState>(INITIAL);

  // Bumped whenever the Session changes; a response that arrives after the
  // context moved on is dropped rather than written over the new one.
  const generation = useRef(0);
  const targetRef = useRef<{ agent_id: string; session: string } | null>(null);

  const loadStatus = useCallback(async (forGeneration: number) => {
    const current = targetRef.current;
    if (!current) {
      return;
    }
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const response = await gitApi.gitStatus(current);
      if (generation.current !== forGeneration) {
        return;
      }
      setState((previous) => ({ ...previous, status: response, loading: false, error: null }));
    } catch (error) {
      if (generation.current !== forGeneration) {
        return;
      }
      setState((previous) => ({
        ...previous,
        status: null,
        loading: false,
        error: message(error),
      }));
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    const forGeneration = generation.current;
    targetRef.current = agentId && sessionId ? { agent_id: agentId, session: sessionId } : null;
    setState({ ...INITIAL, loading: Boolean(targetRef.current) });
    if (targetRef.current) {
      void loadStatus(forGeneration);
    }
    // The two ids are the dependencies, not a `target` object rebuilt on every
    // render: identity would re-run this effect without anything having changed.
  }, [loadStatus, agentId, sessionId]);

  const refresh = useCallback(() => {
    void loadStatus(generation.current);
  }, [loadStatus]);

  const selectFile = useCallback(
    async (path: string) => {
      const current = targetRef.current;
      if (!current) {
        return;
      }
      const forGeneration = generation.current;
      setState((previous) => ({
        ...previous,
        selectedPath: path,
        diff: null,
        diffLoading: true,
        diffError: null,
      }));
      try {
        const response = await gitApi.gitDiff({ ...current, path });
        if (generation.current !== forGeneration) {
          return;
        }
        setState((previous) =>
          previous.selectedPath === path
            ? { ...previous, diff: response, diffLoading: false, diffError: null }
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
    },
    [],
  );

  return { sessionId, state, refresh, selectFile };
}

export function GitWorkspace({ ctx }: { ctx: WorkspaceContext }) {
  const { sessionId, state, refresh, selectFile } = useGitWorkspace(ctx);

  if (!sessionId) {
    return (
      <GitNotice testId="git-no-session">
        Select a Session to see the state of its repository.
      </GitNotice>
    );
  }

  return (
    <div data-testid="git-workspace" className="flex h-full min-h-0 flex-col">
      <GitHeader status={state.status} loading={state.loading} onRefresh={refresh} />
      <GitBody state={state} onSelect={selectFile} />
    </div>
  );
}

function GitHeader({
  status,
  loading,
  onRefresh,
}: {
  status: GitStatusResponse | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const ok = status?.state === 'ok' ? status.status : null;
  const branch = ok?.detached ? 'Detached HEAD' : (ok?.branch ?? null);

  return (
    <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
      <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p data-testid="git-branch" className="truncate text-sm font-medium">
          {branch ?? 'Repository'}
        </p>
        <p data-testid="git-summary" className="truncate text-xs text-muted-foreground">
          {headerSummary(status, loading)}
        </p>
      </div>
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

function headerSummary(status: GitStatusResponse | null, loading: boolean): string {
  if (loading) {
    return 'Reading repository…';
  }
  if (!status) {
    return '';
  }
  if (status.state !== 'ok') {
    return describeUnavailable(status).title;
  }
  if (status.truncated) {
    // A partial listing presented as a whole one is the failure C3 names; the
    // count is the first thing that would be wrong, so it says so here.
    return `${describeStatus(status.status)} — listing truncated, ${formatBytes(status.truncatedBytes)} not read`;
  }
  return describeStatus(status.status);
}

function GitBody({
  state,
  onSelect,
}: {
  state: GitWorkspaceState;
  onSelect: (path: string) => void;
}) {
  if (state.loading) {
    return (
      <GitNotice testId="git-loading">Reading repository state…</GitNotice>
    );
  }
  if (state.error) {
    return (
      <GitNotice testId="git-transport-error" destructive>
        {state.error}
      </GitNotice>
    );
  }
  if (!state.status) {
    return <GitNotice testId="git-empty">No repository state yet.</GitNotice>;
  }
  if (state.status.state !== 'ok') {
    const copy = describeUnavailable(state.status);
    return (
      <div
        data-testid="git-unavailable"
        data-state={state.status.state}
        className="flex h-full min-h-0 items-center justify-center px-6 text-center"
      >
        <div className="max-w-sm space-y-1.5">
          <p className="text-sm font-medium text-foreground">{copy.title}</p>
          {copy.detail ? (
            <p className="text-xs text-muted-foreground">{copy.detail}</p>
          ) : null}
        </div>
      </div>
    );
  }

  const { status } = state.status;
  const rows = statusRows(status);
  if (rows.length === 0) {
    // A clean tree is healthy, so it says so plainly and offers nothing —
    // `visual-language.md` P6. And with nothing to open, the diff pane has no
    // subject: the layout drops rather than sitting there empty.
    return (
      <GitNotice testId="git-clean">
        Nothing has changed since the last commit.
      </GitNotice>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(12rem,20rem)_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-y-auto border-r">
        <GitChangeList
          rows={rows}
          selectedPath={state.selectedPath}
          onSelect={onSelect}
        />
      </aside>
      <main className="flex min-h-0 flex-col">
        <GitDiffView
          response={state.diff}
          loading={state.diffLoading}
          error={state.diffError}
        />
      </main>
    </div>
  );
}

function GitNotice({
  testId,
  destructive,
  children,
}: {
  testId: string;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex h-full min-h-0 items-center justify-center px-6 text-center"
    >
      <p
        role={destructive ? 'alert' : undefined}
        className={destructive ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
      >
        {children}
      </p>
    </div>
  );
}
