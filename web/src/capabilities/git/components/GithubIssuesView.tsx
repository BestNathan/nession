import { useCallback, useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Markdown } from '@/shared/markdown';
import { githubApi } from '../GithubPlugin';
import { asGithubError, type GithubIssueDetail, type GithubIssueFilter, type GithubIssueSummary, type GithubRepositoryRef } from '../githubTypes';
import { useGithubPagedList } from '../hooks/useGithubPagedList';
import { useGithubRequest } from '../hooks/useGithubRequest';
import { GithubNotice } from './GithubNotice';
import { GithubReaderLayout } from './GithubReaderLayout';

const FILTERS: { value: GithubIssueFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

export function GithubIssuesView({
  agentId,
  sessionId,
  remoteName,
  repository,
}: {
  agentId: string;
  sessionId: string;
  remoteName: string;
  repository: GithubRepositoryRef;
}) {
  const [filter, setFilter] = useState<GithubIssueFilter>('open');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [readerOpen, setReaderOpen] = useState(false);
  const [focusReading, setFocusReading] = useState(false);

  const load = useCallback(
    async (
      target: { agent_id: string; session: string; remote_name?: string },
      cursor: string | null,
      refresh: boolean,
    ) => {
      const response = await githubApi.issues({
        ...target,
        state: filter,
        limit: 20,
        cursor: cursor ?? undefined,
        refresh,
      });
      if (response.state === 'error') {
        throw asGithubError(response) ?? response;
      }
      return { items: response.issues, nextCursor: response.nextCursor ?? null };
    },
    [filter],
  );

  const list = useGithubPagedList<GithubIssueSummary>({
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
      (issue) =>
        issue.title.toLowerCase().includes(query) ||
        String(issue.number).includes(query) ||
        issue.author.login.toLowerCase().includes(query),
    );
  }, [list.items, search]);

  return (
    <GithubReaderLayout
      testId="github-issues"
      listTestId="github-issue-list"
      readerTestId="github-issue-reader"
      selected={selected !== null}
      detailOpen={readerOpen}
      focusReading={focusReading}
      onFocusReading={setFocusReading}
      onBack={() => setReaderOpen(false)}
      list={
        <>
          <IssuesToolbar
            filter={filter}
            onFilterChange={setFilter}
            search={search}
            onSearchChange={setSearch}
            onRefresh={list.refresh}
          />
          <IssuesListBody
            error={list.error}
            loading={list.loading}
            loadingMore={list.loadingMore}
            hasMore={list.hasMore}
            issues={visible}
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
          <GithubNotice testId="github-issue-none">Select an Issue to read it.</GithubNotice>
        ) : (
          <GithubIssueReader
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

function IssuesListBody({
  error,
  loading,
  loadingMore,
  hasMore,
  issues,
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
  issues: GithubIssueSummary[];
  search: string;
  selected: number | null;
  onSelect: (number: number) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
}) {
  return (
    <div data-testid="github-issue-list-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
      {error ? (
        <GithubNotice error={error} testId="github-issues-error" onRetry={onRefresh} />
      ) : loading ? (
        <GithubNotice testId="github-issues-loading">Reading Issues…</GithubNotice>
      ) : issues.length === 0 ? (
        <GithubNotice testId="github-issues-empty">
          {search ? 'No loaded Issue matches this search.' : 'No Issues in this filter.'}
        </GithubNotice>
      ) : (
        <ul className="flex flex-col gap-1">
          {issues.map((issue) => (
            <IssueRow
              key={issue.number}
              issue={issue}
              selected={selected === issue.number}
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
            data-testid="github-issues-load-more"
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

function IssuesToolbar({
  filter,
  onFilterChange,
  search,
  onSearchChange,
  onRefresh,
}: {
  filter: GithubIssueFilter;
  onFilterChange: (filter: GithubIssueFilter) => void;
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
            data-testid={`github-filter-${option.value}`}
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
          data-testid="github-issues-refresh"
          aria-label="Refresh Issues"
          onClick={() => onRefresh()}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
      <div className="shrink-0 border-b px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <Input
            data-testid="github-issues-search"
            aria-label="Search Issues"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search loaded Issues"
            className="h-8 pl-7"
          />
        </div>
      </div>
    </>
  );
}

function IssueRow({
  issue,
  selected,
  onSelect,
}: {
  issue: GithubIssueSummary;
  selected: boolean;
  onSelect: (number: number) => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid={`github-issue-row-${issue.number}`}
        aria-current={selected}
        onClick={() => onSelect(issue.number)}
        className={cn(
          'flex w-full flex-col gap-1 rounded-[var(--nession-radius-control)] px-2 py-2 text-left hover:bg-muted',
          selected && 'bg-muted',
        )}
      >
        <span className="flex items-baseline gap-2">
          <span className="text-muted-foreground">#{issue.number}</span>
          <span className={cn('line-clamp-2', chromeSansRole('primary'))}>{issue.title}</span>
        </span>
        <span className={cn('flex flex-wrap items-center gap-2 text-muted-foreground', chromeSansRole('metadata'))}>
          <span>{issue.state}</span>
          <span>·</span>
          <span>{issue.author.login}</span>
          {issue.labels.slice(0, 3).map((label) => (
            <span key={label.name} className={cn('rounded-full border px-1.5', chromeSansRole('metadata'))}>
              {label.name}
            </span>
          ))}
        </span>
      </button>
    </li>
  );
}

function GithubIssueReader({
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
      const response = await githubApi.issueDetail({ ...target, number });
      if (response.state === 'error') {
        throw asGithubError(response) ?? response;
      }
      return response;
    },
    [number],
  );
  const detail = useGithubRequest({
    agentId,
    sessionId,
    remoteName,
    load,
  });
  const issue = detail.data?.issue;

  if (detail.error) {
    return <GithubNotice error={detail.error} testId="github-issue-detail-error" onRetry={detail.refresh} />;
  }
  if (detail.loading || !issue) {
    return <GithubNotice testId="github-issue-detail-loading">Reading Issue…</GithubNotice>;
  }
  return <GithubIssueDetailBody issue={issue} repository={repository} />;
}

export function GithubIssueDetailBody({
  issue,
  repository,
}: {
  issue: GithubIssueDetail;
  repository: GithubRepositoryRef;
}) {
  return (
    <article data-testid={`github-issue-detail-${issue.number}`} className="flex flex-col gap-3 p-4 pb-16">
      <header className="flex flex-col gap-1">
        <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>#{issue.number}</p>
        <h2 className={chromeSansRole('title')}>{issue.title}</h2>
        <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
          {issue.state} · {issue.author.login} · updated {issue.updatedAt}
        </p>
      </header>
      {issue.labels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {issue.labels.map((label) => (
            <span key={label.name} className={cn('rounded-full border px-2 py-0.5', chromeSansRole('metadata'))}>
              {label.name}
            </span>
          ))}
        </div>
      ) : null}
      <Markdown variant="document">{issue.body || '_No description._'}</Markdown>
      <GithubSourceLink url={issue.url} repository={repository} />
    </article>
  );
}

export function GithubSourceLink({
  url,
  repository,
}: {
  url: string;
  repository: GithubRepositoryRef;
}) {
  const approved = url.startsWith(`https://${repository.host}/`);
  if (!approved) {
    return null;
  }
  return (
    <a
      data-testid="github-source-link"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('text-primary underline-offset-4 hover:underline', chromeSansRole('body'))}
    >
      Open on GitHub ↗
    </a>
  );
}
