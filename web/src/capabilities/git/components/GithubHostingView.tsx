import { useCallback, useState } from 'react';
import { Globe, RefreshCw } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { Button } from '@/components/ui/button';
import { githubApi } from '../GithubPlugin';
import type {
  GithubRepositoryOk,
  GithubRemoteChoice,
} from '../githubTypes';
import { useGithubRequest } from '../hooks/useGithubRequest';
import { GithubActionsView } from './GithubActionsView';
import { GithubIssuesView } from './GithubIssuesView';
import { GithubNotice } from './GithubNotice';
import { GithubPullRequestsView } from './GithubPullRequestsView';

type GithubSection = 'issues' | 'pull-requests' | 'actions';

const SECTIONS: { value: GithubSection; label: string }[] = [
  { value: 'issues', label: 'Issues' },
  { value: 'pull-requests', label: 'Pull Requests' },
  { value: 'actions', label: 'Actions' },
];

/**
 * The GitHub half of the one Git capability (#1290).
 *
 * Repository identity is resolved agent-side from the Session's live Git
 * remotes. Only a discovered `remote_name` can be chosen here; there is no
 * host/owner/repo input. Each depth is mounted only while visible, so entering
 * GitHub does not fetch Issues, PRs and Actions together.
 */
export function GithubHostingView({
  agentId,
  sessionId,
}: {
  agentId: string;
  sessionId: string;
}) {
  const [requestedRemote, setRequestedRemote] = useState<string | undefined>(undefined);
  const [section, setSection] = useState<GithubSection>('issues');
  const load = useCallback(
    (target: { agent_id: string; session: string; remote_name?: string }) =>
      githubApi.repository(target),
    [],
  );
  const repository = useGithubRequest({
    agentId,
    sessionId,
    remoteName: requestedRemote,
    load,
  });
  const data = repository.data as GithubRepositoryOk | null;

  return (
    <div data-testid="github-hosting" className="flex min-h-0 flex-1 flex-col">
      <RepositoryHeader
        data={data}
        loading={repository.loading}
        onRemoteChange={setRequestedRemote}
        onRefresh={repository.refresh}
      />
      <RepositoryBody
        data={data}
        error={repository.error}
        loading={repository.loading}
        section={section}
        onSectionChange={setSection}
        onRemoteChange={setRequestedRemote}
        onRetry={repository.refresh}
        agentId={agentId}
        sessionId={sessionId}
      />
    </div>
  );
}

function RepositoryHeader({
  data,
  loading,
  onRemoteChange,
  onRefresh,
}: {
  data: GithubRepositoryOk | null;
  loading: boolean;
  onRemoteChange: (remoteName: string | undefined) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2">
      <Globe className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p
          data-testid="github-repository"
          className={cn('truncate', chromeSansRole('primary'))}
        >
          {data?.repository
            ? `GitHub · ${data.repository.host}/${data.repository.owner}/${data.repository.repo}`
            : 'GitHub'}
        </p>
        <p
          data-testid="github-repository-summary"
          className={cn('truncate text-muted-foreground', chromeSansRole('metadata'))}
        >
          {loading
            ? 'Resolving the Session repository…'
            : data?.repository
              ? `${data.repository.remoteName}${data.branch ? ` · ${data.branch}` : ' · detached HEAD'}`
              : 'No hosting identity resolved'}
        </p>
      </div>
      {data && data.choices.length > 1 ? (
        <label className={cn('flex items-center gap-2 text-muted-foreground', chromeSansRole('metadata'))}>
          Remote
          <select
            data-testid="github-remote-select"
            className="h-8 rounded-[var(--nession-radius-control)] border bg-background px-2"
            value={data.repository?.remoteName ?? ''}
            onChange={(event) => onRemoteChange(event.target.value || undefined)}
          >
            {data.choices.map((choice: GithubRemoteChoice) => (
              <option key={choice.remoteName} value={choice.remoteName}>
                {choice.remoteName} · {choice.owner}/{choice.repo}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="github-repository-refresh"
        aria-label="Refresh GitHub repository"
        onClick={() => onRefresh()}
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  );
}

function RepositoryBody({
  data,
  error,
  loading,
  section,
  onSectionChange,
  onRemoteChange,
  onRetry,
  agentId,
  sessionId,
}: {
  data: GithubRepositoryOk | null;
  error: ReturnType<typeof useGithubRequest>['error'];
  loading: boolean;
  section: GithubSection;
  onSectionChange: (section: GithubSection) => void;
  onRemoteChange: (remoteName: string | undefined) => void;
  onRetry: () => void;
  agentId: string;
  sessionId: string;
}) {
  if (error) {
    return <GithubNotice error={error} testId="github-repository-error" onRetry={onRetry} />;
  }
  if (loading) {
    return <GithubNotice testId="github-repository-loading">Resolving the repository…</GithubNotice>;
  }
  if (!data) {
    return <GithubNotice testId="github-repository-empty">No GitHub repository identity.</GithubNotice>;
  }
  if (data.resolution === 'no_remote') {
    return (
      <GithubNotice testId="github-no-remote">
        This repository has no GitHub remote. Local Repository remains available.
      </GithubNotice>
    );
  }
  if (data.resolution === 'host_not_allowed') {
    return (
      <div data-testid="github-host-not-allowed">
        <GithubNotice>This repository host is not approved for authenticated GitHub reads.</GithubNotice>
        <RemoteChoices choices={data.choices} onSelect={onRemoteChange} />
      </div>
    );
  }
  if (data.resolution === 'ambiguous') {
    return (
      <div data-testid="github-ambiguous-remote">
        <GithubNotice>Choose which discovered GitHub remote this capability should read.</GithubNotice>
        <RemoteChoices choices={data.choices} onSelect={onRemoteChange} />
      </div>
    );
  }
  if (data.resolution === 'not_a_repository') {
    return (
      <GithubNotice testId="github-not-a-repository">This Session is not in a Git repository.</GithubNotice>
    );
  }
  if (!data.authenticated) {
    return (
      <GithubNotice testId="github-auth-unavailable">
        The Agent has no GitHub credential. Set GITHUB_TOKEN or GH_TOKEN on the Agent host to read
        Issues, Pull Requests and Actions.
      </GithubNotice>
    );
  }
  if (!data.repository) {
    return <GithubNotice testId="github-repository-empty">No GitHub repository identity.</GithubNotice>;
  }
  return (
    <>
      <GithubDepthTabs section={section} onSectionChange={onSectionChange} />
      {section === 'issues' ? (
        <GithubIssuesView
          agentId={agentId}
          sessionId={sessionId}
          remoteName={data.repository.remoteName}
          repository={data.repository}
        />
      ) : section === 'pull-requests' ? (
        <GithubPullRequestsView
          agentId={agentId}
          sessionId={sessionId}
          remoteName={data.repository.remoteName}
          repository={data.repository}
          branch={data.branch}
        />
      ) : (
        <GithubActionsView
          agentId={agentId}
          sessionId={sessionId}
          remoteName={data.repository.remoteName}
          branch={data.branch}
        />
      )}
    </>
  );
}

function GithubDepthTabs({
  section,
  onSectionChange,
}: {
  section: GithubSection;
  onSectionChange: (section: GithubSection) => void;
}) {
  return (
    <div className="shrink-0 border-b px-3 py-2">
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="GitHub depth">
        {SECTIONS.map((entry) => (
          <Button
            key={entry.value}
            type="button"
            role="tab"
            size="sm"
            variant={section === entry.value ? 'secondary' : 'ghost'}
            aria-selected={section === entry.value}
            data-testid={`github-tab-${entry.value}`}
            onClick={() => onSectionChange(entry.value)}
          >
            {entry.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function RemoteChoices({
  choices,
  onSelect,
}: {
  choices: GithubRemoteChoice[];
  onSelect: (remoteName: string) => void;
}) {
  if (choices.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-2 px-4 pb-4" data-testid="github-remote-choices">
      {choices.map((choice) => (
        <Button
          key={choice.remoteName}
          type="button"
          variant="outline"
          size="sm"
          data-testid={`github-remote-choice-${choice.remoteName}`}
          onClick={() => onSelect(choice.remoteName)}
        >
          {choice.remoteName} · {choice.host}/{choice.owner}/{choice.repo}
        </Button>
      ))}
    </div>
  );
}
