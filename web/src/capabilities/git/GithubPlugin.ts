import {
  PROTOCOL as REPOSITORY_PROTOCOL,
  VERSION as REPOSITORY_VERSION,
  WIRE as REPOSITORY_WIRE,
} from '@/generated/protocol/github/repository/v1';
import {
  PROTOCOL as ISSUES_PROTOCOL,
  VERSION as ISSUES_VERSION,
  WIRE as ISSUES_WIRE,
} from '@/generated/protocol/github/issues/v1';
import {
  PROTOCOL as ISSUE_DETAIL_PROTOCOL,
  VERSION as ISSUE_DETAIL_VERSION,
  WIRE as ISSUE_DETAIL_WIRE,
} from '@/generated/protocol/github/issue-detail/v1';
import {
  PROTOCOL as PULL_REQUESTS_PROTOCOL,
  VERSION as PULL_REQUESTS_VERSION,
  WIRE as PULL_REQUESTS_WIRE,
} from '@/generated/protocol/github/pull-requests/v1';
import {
  PROTOCOL as PULL_REQUEST_DETAIL_PROTOCOL,
  VERSION as PULL_REQUEST_DETAIL_VERSION,
  WIRE as PULL_REQUEST_DETAIL_WIRE,
} from '@/generated/protocol/github/pull-request-detail/v1';
import {
  PROTOCOL as WORKFLOWS_PROTOCOL,
  VERSION as WORKFLOWS_VERSION,
  WIRE as WORKFLOWS_WIRE,
} from '@/generated/protocol/github/workflows/v1';
import { addressedPayload } from '@/platform/protocol';
import type { PluginSurface, TransportPlugin } from '@/platform/socket/types';
import type {
  GithubIssueDetailRequest,
  GithubIssueDetailResponse,
  GithubIssuesRequest,
  GithubIssuesResponse,
  GithubPullRequestDetailRequest,
  GithubPullRequestDetailResponse,
  GithubPullRequestsRequest,
  GithubPullRequestsResponse,
  GithubRepositoryRequest,
  GithubRepositoryResponse,
  GithubWorkflowsRequest,
  GithubWorkflowsResponse,
} from './githubTypes';

/**
 * The contracts this client was written against.
 *
 * A Consumer Requirement, resolved per target against the agent's manifest —
 * the same mechanism `git.*` uses. GitHub and local Git travel through one
 * server connection but remain independently versioned units.
 */
const CONSUMER_REQUIREMENTS = {
  [REPOSITORY_PROTOCOL]: [REPOSITORY_VERSION],
  [ISSUES_PROTOCOL]: [ISSUES_VERSION],
  [ISSUE_DETAIL_PROTOCOL]: [ISSUE_DETAIL_VERSION],
  [PULL_REQUESTS_PROTOCOL]: [PULL_REQUESTS_VERSION],
  [PULL_REQUEST_DETAIL_PROTOCOL]: [PULL_REQUEST_DETAIL_VERSION],
  [WORKFLOWS_PROTOCOL]: [WORKFLOWS_VERSION],
} as const satisfies Record<string, readonly number[]>;

type GithubUnit = keyof typeof CONSUMER_REQUIREMENTS;

/**
 * The GitHub hosting context for the Git capability (#1290).
 *
 * A transport plugin, not a product capability: the Web presents it inside
 * the existing Git Workspace. Every request carries the Session and, when the
 * user chose one, the Agent-discovered remote name. Nothing here can name a
 * host, owner, repository or endpoint.
 */
export class GithubPlugin implements TransportPlugin {
  readonly name = 'github';

  private connection: PluginSurface | null = null;

  install(connection: PluginSurface): () => void {
    this.connection = connection;
    return () => {
      if (this.connection === connection) {
        this.connection = null;
      }
    };
  }

  async repository(req: GithubRepositoryRequest): Promise<GithubRepositoryResponse> {
    return this.requireConnection().request<GithubRepositoryResponse>(
      REPOSITORY_WIRE,
      this.addressed(REPOSITORY_PROTOCOL, req.agent_id, req),
    );
  }

  async issues(req: GithubIssuesRequest): Promise<GithubIssuesResponse> {
    return this.requireConnection().request<GithubIssuesResponse>(
      ISSUES_WIRE,
      this.addressed(ISSUES_PROTOCOL, req.agent_id, req),
    );
  }

  async issueDetail(req: GithubIssueDetailRequest): Promise<GithubIssueDetailResponse> {
    return this.requireConnection().request<GithubIssueDetailResponse>(
      ISSUE_DETAIL_WIRE,
      this.addressed(ISSUE_DETAIL_PROTOCOL, req.agent_id, req),
    );
  }

  async pullRequests(req: GithubPullRequestsRequest): Promise<GithubPullRequestsResponse> {
    return this.requireConnection().request<GithubPullRequestsResponse>(
      PULL_REQUESTS_WIRE,
      this.addressed(PULL_REQUESTS_PROTOCOL, req.agent_id, req),
    );
  }

  async pullRequestDetail(req: GithubPullRequestDetailRequest): Promise<GithubPullRequestDetailResponse> {
    return this.requireConnection().request<GithubPullRequestDetailResponse>(
      PULL_REQUEST_DETAIL_WIRE,
      this.addressed(PULL_REQUEST_DETAIL_PROTOCOL, req.agent_id, req),
    );
  }

  async workflows(req: GithubWorkflowsRequest): Promise<GithubWorkflowsResponse> {
    return this.requireConnection().request<GithubWorkflowsResponse>(
      WORKFLOWS_WIRE,
      this.addressed(WORKFLOWS_PROTOCOL, req.agent_id, req),
    );
  }

  private addressed(
    unit: GithubUnit,
    agentId: string,
    req: { session: string },
  ): Record<string, unknown> {
    const connection = this.requireConnection();
    return addressedPayload({
      unit,
      target: agentId,
      requirements: CONSUMER_REQUIREMENTS[unit],
      protocols: connection.protocols.targetProtocols(agentId),
      payload: { ...req },
    });
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('GitHub capability is not connected');
    }
    return this.connection;
  }
}

/** App-level singleton, bound by the WebSocket service like the Git plugin. */
export const githubApi = new GithubPlugin();
