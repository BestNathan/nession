import { useCallback, useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Markdown } from '@/shared/markdown';
import { githubApi } from '../GithubPlugin';
import { asGithubError, type GithubBranchRelation, type GithubPullRequestDetail, type GithubPullRequestFilter, type GithubPullRequestSummary, type GithubRepositoryRef } from '../githubTypes';
import { useGithubPagedList } from '../hooks/useGithubPagedList';
import { useGithubRequest } from '../hooks/useGithubRequest';
import { GithubNotice } from './GithubNotice';
import { GithubReaderLayout } from './GithubReaderLayout';
import { GithubSourceLink } from './GithubIssuesView';

const FILTERS: { value: GithubPullRequestFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

function relationLabel(relation: GithubBranchRelation, number: number | null | undefined): string {
  if (relation === 'matched' && number) {
    return `Current branch · PR #${number}`;
  }
  if (relation === 'ambiguous') {
    return 'Current branch · more than one matching PR';
  }
  return 'Current branch · no matching PR';
}

export function GithubPullRequestsView({
  agentId,
  sessionId,
  remoteName,
  repository,
  branch,
}: {
  agentId: string;
  sessionId: string;
  remoteName: string;
  repository: GithubRepositoryRef;
  branch?: string | null;
}) {
  const [filter, setFilter] = useState<GithubPullRequestFilter>('open');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [readerOpen, setReaderOpen] = useState(false);
  const [focusReading, setFocusReading] = useState(false);
  const [relation, setRelation] = useState<{
    relation: GithubBranchRelation;
    number?: number | null;
  }>({ relation: 'none' });

  const load = useCallback(
    async (
      target: { agent_id: string; session: string; remote_name?: string },
      cursor: string | null,
      refresh: boolean,
    ) => {
      const response = await githubApi.pullRequests({
        ...target,
        state: filter,
        limit: 20,
        cursor: cursor ?? undefined,
        refresh,
      });
      if (response.state === 'error') {
        throw asGithubError(response) ?? response;
      }
      setRelation({ relation: response.currentBranch, number: response.currentBranchPr });
      return { items: response.pullRequests, nextCursor: response.nextCursor ?? null };
    },
    [filter],
  );

  const list = useGithubPagedList<GithubPullRequestSummary>({
    agentId,
    sessionId,
    remoteName,
    key: filter,
    load,
  });

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return list.items;
    }
    return list.items.filter(
      (pull) =>
        pull.title.toLowerCase().includes(query) ||
        String(pull.number).includes(query) ||
        pull.author.login.toLowerCase().includes(query) ||
        pull.head.ref.toLowerCase().includes(query),
    );
  }, [list.items, search]);

  return (
    <GithubReaderLayout
      testId="github-pull-requests"
      listTestId="github-pr-list"
      readerTestId="github-pr-reader"
      selected={selected !== null}
      detailOpen={readerOpen}
      focusReading={focusReading}
      onFocusReading={setFocusReading}
      onBack={() => setReaderOpen(false)}
      list={
        <>
          <div className={cn('shrink-0 border-b px-3 py-2 text-muted-foreground', chromeSansRole('metadata'))} data-testid="github-pr-relation">
            {relationLabel(relation.relation, relation.number)}
            {branch ? ` · ${branch}` : ''}
          </div>
          <PullRequestsToolbar
            filter={filter}
            onFilterChange={setFilter}
            search={search}
            onSearchChange={setSearch}
            onRefresh={list.refresh}
          />
          <PullRequestListBody
            error={list.error}
            loading={list.loading}
            loadingMore={list.loadingMore}
            hasMore={list.hasMore}
            pullRequests={visible}
            search={search}
            selected={selected}
            onSelect={(number) => {
              setSelected(number);
              setReaderOpen(true);
            }}
            onRefresh={list.refresh}
            onLoadMore={list.loadMore}
          />
        </>
      }
      reader={
        selected === null ? (
          <GithubNotice testId="github-pr-none">Select a Pull Request to read it.</GithubNotice>
        ) : (
          <GithubPullRequestReader
            agentId={agentId}
            sessionId={sessionId}
            remoteName={remoteName}
            repository={repository}
            number={selected}
          />
        )
      }
    />
  );
}

function PullRequestListBody({
  error,
  loading,
  loadingMore,
  hasMore,
  pullRequests,
  search,
  selected,
  onSelect,
  onRefresh,
  onLoadMore,
}: {
  error: ReturnType<typeof useGithubPagedList>['error'];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  pullRequests: GithubPullRequestSummary[];
  search: string;
  selected: number | null;
  onSelect: (number: number) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
      {error ? (
        <GithubNotice error={error} testId="github-pr-error" onRetry={onRefresh} />
      ) : loading ? (
        <GithubNotice testId="github-pr-loading">Reading Pull Requests…</GithubNotice>
      ) : pullRequests.length === 0 ? (
        <GithubNotice testId="github-pr-empty">
          {search ? 'No loaded Pull Request matches this search.' : 'No Pull Requests in this filter.'}
        </GithubNotice>
      ) : (
        <ul className="flex flex-col gap-1">
          {pullRequests.map((pull) => (
            <PullRequestRow
              key={pull.number}
              pull={pull}
              selected={selected === pull.number}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
      {hasMore && !loading && !error ? (
        <div className="p-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="github-pr-load-more"
            disabled={loadingMore}
            onClick={() => onLoadMore()}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PullRequestsToolbar({
  filter,
  onFilterChange,
  search,
  onSearchChange,
  onRefresh,
}: {
  filter: GithubPullRequestFilter;
  onFilterChange: (filter: GithubPullRequestFilter) => void;
  search: string;
  onSearchChange: (search: string) => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        {FILTERS.map((option) => (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant={filter === option.value ? 'secondary' : 'ghost'}
            data-testid={`github-pr-filter-${option.value}`}
            aria-pressed={filter === option.value}
            onClick={() => onFilterChange(option.value)}
          >
            {option.label}
          </Button>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="github-pr-refresh"
          aria-label="Refresh Pull Requests"
          onClick={() => onRefresh()}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
      <div className="shrink-0 border-b px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <Input
            data-testid="github-pr-search"
            aria-label="Search Pull Requests"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search loaded Pull Requests"
            className="h-8 pl-7"
          />
        </div>
      </div>
    </>
  );
}

function PullRequestRow({
  pull,
  selected,
  onSelect,
}: {
  pull: GithubPullRequestSummary;
  selected: boolean;
  onSelect: (number: number) => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid={`github-pr-row-${pull.number}`}
        aria-current={selected}
        onClick={() => onSelect(pull.number)}
        className={cn(
          'flex w-full flex-col gap-1 rounded-[var(--nession-radius-control)] px-2 py-2 text-left hover:bg-muted',
          selected && 'bg-muted',
        )}
      >
        <span className="flex items-baseline gap-2">
          <span className="text-muted-foreground">#{pull.number}</span>
          <span className={cn('line-clamp-2', chromeSansRole('primary'))}>{pull.title}</span>
        </span>
        <span className={cn('flex flex-wrap items-center gap-2 text-muted-foreground', chromeSansRole('metadata'))}>
          <span>{pull.state}</span>
          {pull.draft ? <span>· draft</span> : null}
          {pull.merged ? <span>· merged</span> : null}
          <span>·</span>
          <span>{pull.author.login}</span>
          <span>·</span>
          <span className="truncate">
            {pull.head.owner}:{pull.head.ref} → {pull.base.ref}
          </span>
        </span>
      </button>
    </li>
  );
}

function GithubPullRequestReader({
  agentId,
  sessionId,
  remoteName,
  repository,
  number,
}: {
  agentId: string;
  sessionId: string;
  remoteName: string;
  repository: GithubRepositoryRef;
  number: number;
}) {
  const load = useCallback(
    async (target: { agent_id: string; session: string; remote_name?: string }) => {
      const response = await githubApi.pullRequestDetail({ ...target, number });
      if (response.state === 'error') {
        throw asGithubError(response) ?? response;
      }
      return response;
    },
    [number],
  );
  const detail = useGithubRequest({ agentId, sessionId, remoteName, load });
  const pull = detail.data?.pullRequest;

  if (detail.error) {
    return <GithubNotice error={detail.error} testId="github-pr-detail-error" onRetry={detail.refresh} />;
  }
  if (detail.loading || !pull) {
    return <GithubNotice testId="github-pr-detail-loading">Reading Pull Request…</GithubNotice>;
  }
  return <GithubPullRequestDetailBody pull={pull} repository={repository} />;
}

export function GithubPullRequestDetailBody({
  pull,
  repository,
}: {
  pull: GithubPullRequestDetail;
  repository: GithubRepositoryRef;
}) {
  return (
    <article data-testid={`github-pr-detail-${pull.number}`} className="flex flex-col gap-3 p-4 pb-16">
      <header className="flex flex-col gap-1">
        <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>#{pull.number}</p>
        <h2 className={chromeSansRole('title')}>{pull.title}</h2>
        <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
          {pull.state}
          {pull.draft ? ' · draft' : ''}
          {pull.merged ? ' · merged' : ''} · {pull.author.login} · updated {pull.updatedAt}
        </p>
        <p className={cn('text-muted-foreground', chromeSansRole('metadata'))} data-testid="github-pr-detail-refs">
          {pull.head.owner}:{pull.head.ref} ({pull.head.sha.slice(0, 7)}) → {pull.base.ref} ({pull.base.sha.slice(0, 7)})
        </p>
      </header>
      <Markdown variant="document">{pull.body || '_No description._'}</Markdown>
      <GithubSourceLink url={pull.url} repository={repository} />
    </article>
  );
}
