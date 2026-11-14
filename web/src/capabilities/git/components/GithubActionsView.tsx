import { useCallback, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { githubApi } from '../GithubPlugin';
import { asGithubError, type GithubRunScope, type GithubWorkflow } from '../githubTypes';
import { useGithubPagedList } from '../hooks/useGithubPagedList';
import { GithubNotice } from './GithubNotice';

function statusText(workflow: GithubWorkflow): string {
  if (workflow.state === 'disabled') {
    return 'Disabled';
  }
  if (!workflow.latest_run) {
    return 'No runs yet';
  }
  const run = workflow.latest_run;
  if (run.status === 'completed') {
    return run.conclusion ? `Completed · ${run.conclusion}` : 'Completed';
  }
  if (run.status === 'in_progress') {
    return 'In progress';
  }
  if (run.status === 'queued') {
    return 'Queued';
  }
  return 'Unknown status';
}

export function GithubActionsView({
  agentId,
  sessionId,
  remoteName,
  branch,
}: {
  agentId: string;
  sessionId: string;
  remoteName: string;
  branch?: string | null;
}) {
  const [scope, setScope] = useState<GithubRunScope>('repository');

  const load = useCallback(
    async (
      target: { agent_id: string; session: string; remote_name?: string },
      cursor: string | null,
      refresh: boolean,
    ) => {
      const response = await githubApi.workflows({
        ...target,
        scope,
        limit: 30,
        cursor: cursor ?? undefined,
        refresh,
      });
      if (response.state === 'error') {
        throw asGithubError(response) ?? response;
      }
      return { items: response.workflows, nextCursor: response.next_cursor ?? null };
    },
    [scope],
  );

  const list = useGithubPagedList<GithubWorkflow>({
    agentId,
    sessionId,
    remoteName,
    key: scope,
    enabled: scope === 'repository' || Boolean(branch),
    load,
  });

  return (
    <div data-testid="github-actions" className="flex min-h-0 flex-1 flex-col">
      <ActionsToolbar
        scope={scope}
        branch={branch}
        onScopeChange={setScope}
        onRefresh={list.refresh}
      />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-16">
        {list.error ? (
          <GithubNotice error={list.error} testId="github-actions-error" onRetry={list.refresh} />
        ) : list.loading ? (
          <GithubNotice testId="github-actions-loading">Reading Actions…</GithubNotice>
        ) : list.items.length === 0 ? (
          <GithubNotice testId="github-actions-empty">
            {scope === 'branch'
              ? 'No workflow runs on the current branch.'
              : 'No workflows in this repository.'}
          </GithubNotice>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.items.map((workflow) => (
              <WorkflowRow key={workflow.id} workflow={workflow} />
            ))}
          </ul>
        )}
        {list.hasMore && !list.loading && !list.error ? (
          <div className="pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="github-actions-load-more"
              disabled={list.loadingMore}
              onClick={() => list.loadMore()}
            >
              {list.loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ActionsToolbar({
  scope,
  branch,
  onScopeChange,
  onRefresh,
}: {
  scope: GithubRunScope;
  branch?: string | null;
  onScopeChange: (scope: GithubRunScope) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <Button
        type="button"
        size="sm"
        variant={scope === 'repository' ? 'secondary' : 'ghost'}
        data-testid="github-actions-scope-repository"
        aria-pressed={scope === 'repository'}
        onClick={() => onScopeChange('repository')}
      >
        Repository
      </Button>
      <Button
        type="button"
        size="sm"
        variant={scope === 'branch' ? 'secondary' : 'ghost'}
        data-testid="github-actions-scope-branch"
        aria-pressed={scope === 'branch'}
        disabled={!branch}
        onClick={() => onScopeChange('branch')}
      >
        Current branch{branch ? ` · ${branch}` : ''}
      </Button>
      <span
        className={cn('text-muted-foreground', chromeSansRole('metadata'))}
        data-testid="github-actions-scope-label"
      >
        {scope === 'repository'
          ? 'Latest run per workflow · repository'
          : `Latest run per workflow · ${branch ?? 'no branch'}`}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="github-actions-refresh"
        aria-label="Refresh Actions"
        onClick={() => onRefresh()}
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  );
}

function WorkflowRow({ workflow }: { workflow: GithubWorkflow }) {
  return (
    <li
      data-testid={`github-workflow-${workflow.id}`}
      className="flex flex-col gap-1 rounded-[var(--nession-radius-control)] border px-3 py-2"
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className={chromeSansRole('primary')}>{workflow.name}</span>
        <span className={cn('text-muted-foreground', chromeSansRole('metadata'))}>{workflow.path}</span>
      </span>
      <span
        className={cn('text-muted-foreground', chromeSansRole('metadata'))}
        data-testid={`github-workflow-status-${workflow.id}`}
      >
        {statusText(workflow)}
        {workflow.latest_run?.branch ? ` · ${workflow.latest_run.branch}` : ''}
        {workflow.latest_run?.sha ? ` · ${workflow.latest_run.sha.slice(0, 7)}` : ''}
      </span>
      {workflow.latest_run ? (
        <a
          href={workflow.latest_run.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn('text-primary underline-offset-4 hover:underline', chromeSansRole('metadata'))}
        >
          Run on GitHub ↗
        </a>
      ) : null}
    </li>
  );
}
