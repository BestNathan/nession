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
  remoteName: 'origin',
  sourceUrl: 'https://github.com/fixture-owner/nession',
};

const choices = [
  { remoteName: 'origin', host: 'github.com', owner: 'fixture-owner', repo: 'nession' },
  { remoteName: 'upstream', host: 'github.com', owner: 'upstream-owner', repo: 'nession' },
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
    updatedAt: '2026-11-01T00:00:00Z',
    url: 'https://github.com/fixture-owner/nession/issues/1290',
  },
  {
    number: 2514,
    title: 'Session process discovery',
    state: 'closed',
    author: { login: 'fixture-owner' },
    labels: [{ name: 'agent', color: '1d76db' }],
    assignees: [],
    updatedAt: '2026-10-20T00:00:00Z',
    url: 'https://github.com/fixture-owner/nession/issues/2514',
  },
  {
    number: 2323,
    title: 'Acceptance fixture isolation',
    state: 'open',
    author: { login: 'fixture-dev' },
    labels: [],
    assignees: [],
    updatedAt: '2026-10-10T00:00:00Z',
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
    headRefName: 'feature/git-github',
    baseRefName: 'main',
    head: {
      owner: 'fixture-owner',
      repo: 'nession',
      ref: 'feature/git-github',
      sha: '1111111111111111111111111111111111111111',
    },
    base: { ref: 'main', sha: '2222222222222222222222222222222222222222' },
    updatedAt: '2026-11-01T00:00:00Z',
    url: 'https://github.com/fixture-owner/nession/pull/2229',
  },
  {
    number: 2222,
    title: 'Draft: layout experiment',
    state: 'open',
    draft: true,
    merged: false,
    author: { login: 'fixture-owner' },
    headRefName: 'draft/layout',
    baseRefName: 'main',
    head: {
      owner: 'fork-owner',
      repo: 'nession',
      ref: 'draft/layout',
      sha: '3333333333333333333333333333333333333333',
    },
    base: { ref: 'main', sha: '2222222222222222222222222222222222222222' },
    updatedAt: '2026-10-25T00:00:00Z',
    url: 'https://github.com/fixture-owner/nession/pull/2222',
  },
  {
    number: 2218,
    title: 'Merged history walk',
    state: 'closed',
    draft: false,
    merged: true,
    author: { login: 'fixture-dev' },
    headRefName: 'fix/history',
    baseRefName: 'main',
    head: {
      owner: 'fixture-owner',
      repo: 'nession',
      ref: 'fix/history',
      sha: '4444444444444444444444444444444444444444',
    },
    base: { ref: 'main', sha: '2222222222222222222222222222222222222222' },
    updatedAt: '2026-10-01T00:00:00Z',
    url: 'https://github.com/fixture-owner/nession/pull/2218',
  },
];

const workflows: GithubWorkflow[] = [
  {
    id: 1,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    state: 'active',
    latestRun: {
      id: 1001,
      status: 'completed',
      conclusion: 'success',
      branch: 'main',
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      event: 'push',
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:05:00Z',
      url: 'https://github.com/fixture-owner/nession/actions/runs/1001',
    },
  },
  {
    id: 2,
    name: 'E2E / Tests',
    path: '.github/workflows/e2e-tests.yml',
    state: 'active',
    latestRun: {
      id: 1002,
      status: 'queued',
      branch: 'feature/git-github',
      sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      event: 'pull_request',
      createdAt: '2026-11-02T00:00:00Z',
      updatedAt: '2026-11-02T00:00:30Z',
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

function error(code: GithubErrorResponse['code'], message: string, retryAfterSeconds?: number): GithubErrorResponse {
  return { state: 'error', code, message, retryAfterSeconds };
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
        ? { ...repository, remoteName: scenario === 'fork' ? 'upstream' : 'origin' }
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
  const filtered = issues.filter((issue) => state === 'all' || issue.state === state);
  const page = context.scenario === 'empty' ? [] : filtered.slice((cursor - 1) * 2, cursor * 2);
  const hasMore = context.scenario !== 'empty' && cursor * 2 < filtered.length;
  return {
    state: 'ok',
    repository,
    issues: page,
    hasMore,
    nextCursor: hasMore ? String(cursor + 1) : null,
  };
}

function answerIssueDetail(
  context: GithubScenario,
  payload: Record<string, unknown>,
): GithubIssueDetailResponse {
  context.counts.issueDetail += 1;
  if (context.scenario === 'error-detail') {
    return error('not_found', 'fixture missing');
  }
  const issue = issues.find((candidate) => candidate.number === Number(payload.number));
  if (!issue) {
    return error('not_found', 'fixture missing');
  }
  return {
    state: 'ok',
    repository,
    issue: {
      ...issue,
      createdAt: '2026-10-01T00:00:00Z',
      body: ISSUE_BODY,
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
  const filtered = pullRequests.filter((pull) => state === 'all' || pull.state === state);
  const current = filtered.find(
    (pull) =>
      pull.head.owner === repository.owner &&
      pull.head.repo === repository.repo &&
      pull.head.ref === 'feature/git-github',
  );
  return {
    state: 'ok',
    repository,
    pullRequests: context.scenario === 'empty' ? [] : filtered,
    currentBranch: current ? 'matched' : 'none',
    currentBranchPr: current?.number ?? null,
    hasMore: false,
    nextCursor: null,
  };
}

function answerPullRequestDetail(
  context: GithubScenario,
  payload: Record<string, unknown>,
): GithubPullRequestDetailResponse {
  context.counts.pullRequestDetail += 1;
  const pull = pullRequests.find((candidate) => candidate.number === Number(payload.number));
  if (!pull) {
    return error('not_found', 'fixture missing');
  }
  return {
    state: 'ok',
    repository,
    pullRequest: {
      ...pull,
      createdAt: '2026-10-01T00:00:00Z',
      mergedAt: pull.merged ? '2026-10-02T00:00:00Z' : null,
      body: '## Fixture PR\n\nA **read-only** Pull Request body.',
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
  const scoped: GithubWorkflow[] = workflows.map((workflow): GithubWorkflow =>
    workflow.id === 1 && scope === 'branch'
      ? {
          ...workflow,
          latestRun: {
            ...workflow.latestRun!,
            id: 1003,
            branch,
            status: 'in_progress',
            conclusion: null,
          },
        }
      : workflow,
  );
  return {
    state: 'ok',
    repository,
    scope,
    branch: scope === 'branch' ? branch : null,
    workflows: scoped,
    hasMore: false,
    nextCursor: null,
  };
}
