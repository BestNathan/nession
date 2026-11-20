import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import type {
  GithubErrorResponse,
  GithubIssueDetailResponse,
  GithubIssuesResponse,
  GithubPullRequestDetailResponse,
  GithubPullRequestsResponse,
  GithubRepositoryResponse,
  GithubRunScope,
  GithubWorkflow,
  GithubWorkflowsResponse,
} from '@/capabilities/git';
import { FIXTURE_AGENTS } from './fixtureData';

type FixtureGithubCounts = {
  repository: number;
  issues: number;
  issueDetail: number;
  pullRequests: number;
  pullRequestDetail: number;
  workflows: number;
};

type FixtureGithubWindow = Window & { fixtureGithubRequests?: FixtureGithubCounts };

const repository = {
  host: 'github.com',
  owner: 'fixture-owner',
  repo: 'nession',
  remote_name: 'origin',
  source_url: 'https://github.com/fixture-owner/nession',
};

const choices = [
  { remote_name: 'origin', host: 'github.com', owner: 'fixture-owner', repo: 'nession' },
  { remote_name: 'upstream', host: 'github.com', owner: 'upstream-owner', repo: 'nession' },
];

const ISSUE_BODY = `## Fixture Issue

This body is **Markdown**. A link to [the repository](https://github.com/fixture-owner/nession) is safe.
<script>window.fixtureGithubInjected = true</script>
`;

const issues = [
  {
    number: 1290,
    title: 'Read-only GitHub context for the Git capability',
    state: 'open',
    author: { login: 'fixture-dev' },
    labels: [{ name: 'requirement', color: '0e8a16' }],
    assignees: [{ login: 'fixture-dev' }],
    updated_at: '2026-11-01T00:00:00Z',
    url: 'https://github.com/fixture-owner/nession/issues/1290',
  },
  {
    number: 2514,
    title: 'Session process discovery',
    state: 'closed',
    author: { login: 'fixture-owner' },
    labels: [{ name: 'agent', color: '1d76db' }],
    assignees: [],
    updated_at: '2026-10-20T00:00:00Z',
    url: 'https://github.com/fixture-owner/nession/issues/2514',
  },
  {
    number: 2323,
    title: 'Acceptance fixture isolation',
    state: 'open',
    author: { login: 'fixture-dev' },
    labels: [],
    assignees: [],
    updated_at: '2026-10-10T00:00:00Z',
    url: 'https://github.com/fixture-owner/nession/issues/2323',
  },
];

const pullRequests = [
  {
    number: 2229,
    title: 'Add read-only GitHub context',
    state: 'open',
    draft: false,
    merged: false,
    author: { login: 'fixture-dev' },
    head_ref_name: 'feature/git-github',
    base_ref_name: 'main',
    head: {
      owner: 'fixture-owner',
      repo: 'nession',
      ref: 'feature/git-github',
      sha: '1111111111111111111111111111111111111111',
    },
    base: { ref: 'main', sha: '2222222222222222222222222222222222222222' },
    updated_at: '2026-11-01T00:00:00Z',
    url: 'https://github.com/fixture-owner/nession/pull/2229',
  },
  {
    number: 2222,
    title: 'Draft: layout experiment',
    state: 'open',
    draft: true,
    merged: false,
    author: { login: 'fixture-owner' },
    head_ref_name: 'draft/layout',
    base_ref_name: 'main',
    head: {
      owner: 'fork-owner',
      repo: 'nession',
      ref: 'draft/layout',
      sha: '3333333333333333333333333333333333333333',
    },
    base: { ref: 'main', sha: '2222222222222222222222222222222222222222' },
    updated_at: '2026-10-25T00:00:00Z',
    url: 'https://github.com/fixture-owner/nession/pull/2222',
  },
  {
    number: 2218,
    title: 'Merged history walk',
    state: 'closed',
    draft: false,
    merged: true,
    author: { login: 'fixture-dev' },
    head_ref_name: 'fix/history',
    base_ref_name: 'main',
    head: {
      owner: 'fixture-owner',
      repo: 'nession',
      ref: 'fix/history',
      sha: '4444444444444444444444444444444444444444',
    },
    base: { ref: 'main', sha: '2222222222222222222222222222222222222222' },
    updated_at: '2026-10-01T00:00:00Z',
    url: 'https://github.com/fixture-owner/nession/pull/2218',
  },
];

const workflows: GithubWorkflow[] = [
  {
    id: 1,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    state: 'active',
    latest_run: {
      id: 1001,
      status: 'completed',
      conclusion: 'success',
      branch: 'main',
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      event: 'push',
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:05:00Z',
      url: 'https://github.com/fixture-owner/nession/actions/runs/1001',
    },
  },
  {
    id: 2,
    name: 'E2E / Tests',
    path: '.github/workflows/e2e-tests.yml',
    state: 'active',
    latest_run: {
      id: 1002,
      status: 'queued',
      branch: 'feature/git-github',
      sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      event: 'pull_request',
      created_at: '2026-11-02T00:00:00Z',
      updated_at: '2026-11-02T00:00:30Z',
      url: 'https://github.com/fixture-owner/nession/actions/runs/1002',
    },
  },
  {
    id: 3,
    name: 'Disabled workflow',
    path: '.github/workflows/disabled.yml',
    state: 'disabled',
  },
];

/**
 * The deterministic long inventory behind `github=long` (#4188).
 *
 * The canonical fixture answers a handful of rows, which cannot overflow the
 * nested App lists or a pushed reader at a phone width. These are ordinary
 * shapes at a count that requires scrolling, so the Issues / Pull Requests /
 * Actions Cases can measure the end of the real section scrollers.
 */
const LONG_COUNT = 36;

const longIssues = Array.from({ length: LONG_COUNT }, (_, index) => ({
  number: 4001 + index,
  title: `Long fixture Issue ${index + 1}: read-only repository context`,
  state: 'open',
  author: { login: index % 2 === 0 ? 'fixture-dev' : 'fixture-owner' },
  labels: index % 3 === 0 ? [{ name: 'requirement', color: '0e8a16' }] : [],
  assignees: [],
  updated_at: `2026-11-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
  url: `https://github.com/fixture-owner/nession/issues/${4001 + index}`,
}));

const longPullRequests = Array.from({ length: LONG_COUNT }, (_, index) => {
  const ref = index === 0 ? 'feature/git-github' : `feature/long-${String(index).padStart(2, '0')}`;
  return {
    number: 5001 + index,
    title: `Long fixture Pull Request ${index + 1}`,
    state: 'open',
    draft: index % 5 === 0,
    merged: false,
    author: { login: 'fixture-dev' },
    head_ref_name: ref,
    base_ref_name: 'main',
    head: {
      // The first entry is the fixture's own current branch; the rest are a
      // realistic spread of same-repository and fork heads.
      owner: index !== 0 && index % 4 === 0 ? 'fork-owner' : 'fixture-owner',
      repo: 'nession',
      ref,
      sha: String(index + 1).padStart(40, '0'),
    },
    base: { ref: 'main', sha: '2'.repeat(40) },
    updated_at: `2026-11-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    url: `https://github.com/fixture-owner/nession/pull/${5001 + index}`,
  };
});

const longWorkflows: GithubWorkflow[] = Array.from({ length: LONG_COUNT }, (_, index) => ({
  id: 7001 + index,
  name: `Workflow ${index + 1}`,
  path: `.github/workflows/long-${String(index).padStart(2, '0')}.yml`,
  state: index % 6 === 0 ? 'disabled' : 'active',
  latest_run: index % 6 === 0
    ? undefined
    : {
        id: 9001 + index,
        status: index % 3 === 0 ? 'in_progress' : 'completed',
        conclusion: index % 3 === 0 ? null : 'success',
        branch: index === 0 ? 'feature/git-github' : 'main',
        sha: String(index + 1).padStart(40, 'a'),
        event: 'push',
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:05:00Z',
        url: `https://github.com/fixture-owner/nession/actions/runs/${9001 + index}`,
      },
}));

/** A reader body long enough to overflow the pushed App reader on a phone. */
const LONG_DETAIL_BODY = Array.from(
  { length: 40 },
  (_, index) =>
    `### Section ${index + 1}\n\nThis paragraph is part of the deterministic long fixture body (#4188). It exists so the pushed reader has real painted content past the first screenful.\n`,
).join('\n');

function error(code: GithubErrorResponse['code'], message: string, retryAfterSeconds?: number): GithubErrorResponse {
  return { state: 'error', code, message, retry_after_seconds: retryAfterSeconds };
}

interface GithubScenario {
  scenario: string;
  counts: FixtureGithubCounts;
}

export function fixtureGithubSurface(search: string): PluginSurface {
  const scenario = new URLSearchParams(search).get('github') ?? 'resolved';
  const counts: FixtureGithubCounts = {
    repository: 0,
    issues: 0,
    issueDetail: 0,
    pullRequests: 0,
    pullRequestDetail: 0,
    workflows: 0,
  };
  if (typeof window !== 'undefined') {
    (window as FixtureGithubWindow).fixtureGithubRequests = counts;
  }
  const protocols = new ProtocolDirectory();
  protocols.publish(manifestsOf(FIXTURE_AGENTS));
  const context: GithubScenario = { scenario, counts };

  return {
    connectionState: 'connected',
    protocols,
    request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
      switch (type) {
        case 'github.repository':
          return Promise.resolve(answerRepository(context) as T);
        case 'github.issues':
          return Promise.resolve(answerIssues(context, payload) as T);
        case 'github.issue-detail':
          return Promise.resolve(answerIssueDetail(context, payload) as T);
        case 'github.pull-requests':
          return Promise.resolve(answerPullRequests(context, payload) as T);
        case 'github.pull-request-detail':
          return Promise.resolve(answerPullRequestDetail(context, payload) as T);
        case 'github.workflows':
          return Promise.resolve(answerWorkflows(context, payload) as T);
        default:
          return Promise.reject(new Error(`fixture github surface does not answer ${type}`));
      }
    },
    send(): void {},
    subscribe(): () => void {
      return () => {};
    },
    onBinary(): () => void {
      return () => {};
    },
    waitForConnection(): Promise<void> {
      return Promise.resolve();
    },
    onConnectionStateChange(): () => void {
      return () => {};
    },
  };
}

function answerRepository({ scenario, counts }: GithubScenario): GithubRepositoryResponse {
  counts.repository += 1;
  if (scenario === 'unauthorized') {
    return error('access_denied', 'fixture denied');
  }
  if (scenario === 'rate-limited') {
    return error('rate_limited', 'fixture rate limited', 30);
  }
  const resolution =
    scenario === 'no-remote' ? 'no_remote' : scenario === 'ambiguous' ? 'ambiguous' : 'resolved';
  return {
    state: 'ok',
    resolution,
    repository:
      resolution === 'resolved'
        ? { ...repository, remote_name: scenario === 'fork' ? 'upstream' : 'origin' }
        : null,
    branch: 'feature/git-github',
    choices: scenario === 'ambiguous' || scenario === 'fork' ? choices : [choices[0]],
    authenticated: scenario !== 'unauthenticated',
  };
}

function answerIssues(context: GithubScenario, payload: Record<string, unknown>): GithubIssuesResponse {
  context.counts.issues += 1;
  if (context.scenario === 'unauthorized') {
    return error('access_denied', 'fixture denied');
  }
  const state = String(payload.state ?? 'open');
  const cursor = payload.cursor ? Number(payload.cursor) : 1;
  const source = context.scenario === 'long' ? longIssues : issues;
  const filtered = source.filter((issue) => state === 'all' || issue.state === state);
  if (context.scenario === 'long') {
    // The caller's limit is what the real agent clamps to; one page is enough
    // for the long App list to overflow at a phone width.
    const limit = requestedLimit(payload, 20);
    const start = Math.max(0, (cursor - 1) * limit);
    const page = filtered.slice(start, start + limit);
    const hasMore = start + page.length < filtered.length;
    return {
      state: 'ok',
      repository,
      issues: page,
      has_more: hasMore,
      next_cursor: hasMore ? String(cursor + 1) : null,
    };
  }
  const page = context.scenario === 'empty' ? [] : filtered.slice((cursor - 1) * 2, cursor * 2);
  const hasMore = context.scenario !== 'empty' && cursor * 2 < filtered.length;
  return {
    state: 'ok',
    repository,
    issues: page,
    has_more: hasMore,
    next_cursor: hasMore ? String(cursor + 1) : null,
  };
}

/** The page size a real provider would clamp the request to. */
function requestedLimit(payload: Record<string, unknown>, fallback: number): number {
  return typeof payload.limit === 'number' && payload.limit > 0
    ? Math.floor(payload.limit)
    : fallback;
}

function answerIssueDetail(
  context: GithubScenario,
  payload: Record<string, unknown>,
): GithubIssueDetailResponse {
  context.counts.issueDetail += 1;
  if (context.scenario === 'error-detail') {
    return error('not_found', 'fixture missing');
  }
  const source = context.scenario === 'long' ? longIssues : issues;
  const issue = source.find((candidate) => candidate.number === Number(payload.number));
  if (!issue) {
    return error('not_found', 'fixture missing');
  }
  return {
    state: 'ok',
    repository,
    issue: {
      ...issue,
      created_at: '2026-10-01T00:00:00Z',
      body: context.scenario === 'long' ? LONG_DETAIL_BODY : ISSUE_BODY,
    },
  };
}

function answerPullRequests(
  context: GithubScenario,
  payload: Record<string, unknown>,
): GithubPullRequestsResponse {
  context.counts.pullRequests += 1;
  if (context.scenario === 'unauthorized') {
    return error('access_denied', 'fixture denied');
  }
  const state = String(payload.state ?? 'open');
  const source = context.scenario === 'long' ? longPullRequests : pullRequests;
  const filtered = source.filter((pull) => state === 'all' || pull.state === state);
  const current = filtered.find(
    (pull) =>
      pull.head.owner === repository.owner &&
      pull.head.repo === repository.repo &&
      pull.head.ref === 'feature/git-github',
  );
  // `long` honors the caller's page limit and cursor like the real provider;
  // the first page is enough for the nested App list to overflow at a phone
  // width.
  const cursor = payload.cursor ? Math.max(1, Number(payload.cursor)) : 1;
  const limit = requestedLimit(payload, 20);
  const start = (cursor - 1) * limit;
  const page = context.scenario === 'long'
    ? filtered.slice(start, start + limit)
    : context.scenario === 'empty'
      ? []
      : filtered;
  const hasMore =
    context.scenario === 'long' && start + page.length < filtered.length;
  return {
    state: 'ok',
    repository,
    pull_requests: page,
    current_branch:
      context.scenario === 'relation-unknown' ? 'unknown' : current ? 'matched' : 'none',
    current_branch_pr:
      context.scenario === 'relation-unknown' ? null : current?.number ?? null,
    has_more: hasMore,
    next_cursor: hasMore ? '2' : null,
  };
}

function answerPullRequestDetail(
  context: GithubScenario,
  payload: Record<string, unknown>,
): GithubPullRequestDetailResponse {
  context.counts.pullRequestDetail += 1;
  const source = context.scenario === 'long' ? longPullRequests : pullRequests;
  const pull = source.find((candidate) => candidate.number === Number(payload.number));
  if (!pull) {
    return error('not_found', 'fixture missing');
  }
  return {
    state: 'ok',
    repository,
    pull_request: {
      ...pull,
      created_at: '2026-10-01T00:00:00Z',
      merged_at: pull.merged ? '2026-10-02T00:00:00Z' : null,
      body: context.scenario === 'long'
        ? LONG_DETAIL_BODY
        : '## Fixture PR\n\nA **read-only** Pull Request body.',
    },
  };
}

function answerWorkflows(
  context: GithubScenario,
  payload: Record<string, unknown>,
): GithubWorkflowsResponse {
  context.counts.workflows += 1;
  const scope: GithubRunScope = payload.scope === 'branch' ? 'branch' : 'repository';
  const branch = 'feature/git-github';
  const source = context.scenario === 'long' ? longWorkflows : workflows;
  // `long` honors the caller's page limit and cursor like the real provider.
  const cursor = payload.cursor ? Math.max(1, Number(payload.cursor)) : 1;
  const limit = requestedLimit(payload, 30);
  const start = (cursor - 1) * limit;
  const page = context.scenario === 'long'
    ? source.slice(start, start + limit)
    : source;
  const currentId = page.find((workflow) => workflow.latest_run)?.id;
  const scoped: GithubWorkflow[] = page.map((workflow): GithubWorkflow =>
    workflow.id === currentId && scope === 'branch'
      ? {
          ...workflow,
          latest_run: {
            ...workflow.latest_run!,
            id: 1003,
            branch,
            status: 'in_progress',
            conclusion: null,
          },
        }
      : workflow,
  );
  const hasMore = context.scenario === 'long' && start + page.length < source.length;
  return {
    state: 'ok',
    repository,
    scope,
    branch: scope === 'branch' ? branch : null,
    workflows: scoped,
    has_more: hasMore,
    next_cursor: hasMore ? String(cursor + 1) : null,
  };
}
