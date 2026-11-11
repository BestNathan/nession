/**
 * The Git capability's names for the `github.*` wire types (#1290).
 *
 * These are aliases over the generated bindings, not mirrors: the Rust
 * contracts are authoritative, and `just codegen` carries every field here.
 * `agent_id` is added because routing is not part of the contract.
 */
import type {
  RepositoryRequest,
  RepositoryResponse,
  RepositoryOkV1,
  RepositoryStateV1,
  GithubRepositoryRefV1,
  GithubRemoteChoiceV1,
} from '@/generated/protocol/github/repository/v1';
import type {
  IssuesRequest,
  IssuesResponse,
  IssuesOkV1,
  GithubIssueSummaryV1,
  IssueStateFilterV1,
} from '@/generated/protocol/github/issues/v1';
import type {
  IssueDetailRequest,
  IssueDetailResponse,
  IssueDetailOkV1,
  GithubIssueDetailV1,
} from '@/generated/protocol/github/issue-detail/v1';
import type {
  PullRequestsRequest,
  PullRequestsResponse,
  PullRequestsOkV1,
  GithubPullRequestSummaryV1,
  BranchRelationV1,
  PullRequestStateFilterV1,
} from '@/generated/protocol/github/pull-requests/v1';
import type {
  PullRequestDetailRequest,
  PullRequestDetailResponse,
  PullRequestDetailOkV1,
  GithubPullRequestDetailV1,
} from '@/generated/protocol/github/pull-request-detail/v1';
import type {
  WorkflowsRequest,
  WorkflowsResponse,
  WorkflowsOkV1,
  GithubWorkflowV1,
  WorkflowRunV1,
  WorkflowRunStatusV1,
  RunScopeV1,
} from '@/generated/protocol/github/workflows/v1';

export type GithubRepositoryRequest = RepositoryRequest & { agent_id: string };
export type GithubIssuesRequest = IssuesRequest & { agent_id: string };
export type GithubIssueDetailRequest = IssueDetailRequest & { agent_id: string };
export type GithubPullRequestsRequest = PullRequestsRequest & { agent_id: string };
export type GithubPullRequestDetailRequest = PullRequestDetailRequest & { agent_id: string };
export type GithubWorkflowsRequest = WorkflowsRequest & { agent_id: string };

export type GithubRepositoryResponse = RepositoryResponse;
export type GithubIssuesResponse = IssuesResponse;
export type GithubIssueDetailResponse = IssueDetailResponse;
export type GithubPullRequestsResponse = PullRequestsResponse;
export type GithubPullRequestDetailResponse = PullRequestDetailResponse;
export type GithubWorkflowsResponse = WorkflowsResponse;

export type GithubRepositoryOk = RepositoryOkV1;
export type GithubRepositoryRef = GithubRepositoryRefV1;
export type GithubRemoteChoice = GithubRemoteChoiceV1;
export type GithubResolution = RepositoryStateV1;
export type GithubIssuesOk = IssuesOkV1;
export type GithubIssueSummary = GithubIssueSummaryV1;
export type GithubIssueFilter = IssueStateFilterV1;
export type GithubIssueDetailOk = IssueDetailOkV1;
export type GithubIssueDetail = GithubIssueDetailV1;
export type GithubPullRequestsOk = PullRequestsOkV1;
export type GithubPullRequestSummary = GithubPullRequestSummaryV1;
export type GithubPullRequestFilter = PullRequestStateFilterV1;
export type GithubBranchRelation = BranchRelationV1;
export type GithubPullRequestDetailOk = PullRequestDetailOkV1;
export type GithubPullRequestDetail = GithubPullRequestDetailV1;
export type GithubWorkflowsOk = WorkflowsOkV1;
export type GithubWorkflow = GithubWorkflowV1;
export type GithubWorkflowRun = WorkflowRunV1;
export type GithubRunStatus = WorkflowRunStatusV1;
export type GithubRunScope = RunScopeV1;

/** The non-ok half of every GitHub answer. */
export type GithubErrorResponse = Extract<
  | GithubRepositoryResponse
  | GithubIssuesResponse
  | GithubIssueDetailResponse
  | GithubPullRequestsResponse
  | GithubPullRequestDetailResponse
  | GithubWorkflowsResponse,
  { state: 'error' }
>;

export type GithubErrorCode = GithubErrorResponse['code'];
export type GithubError = { code: GithubErrorCode; message: string; retryAfterSeconds?: number | null };

/** Narrow a response or throw its typed error, for hooks that must distinguish. */
export function githubErrorOf<T extends { state: string }>(response: T): GithubError | null {
  if (response.state !== 'error') {
    return null;
  }
  const error = response as unknown as GithubErrorResponse;
  return {
    code: error.code,
    message: error.message,
    retryAfterSeconds: error.retryAfterSeconds,
  };
}

/** Recognize an error a loader threw, so a typed code survives the hook. */
export function asGithubError(value: unknown): GithubError | null {
  if (
    value !== null &&
    typeof value === 'object' &&
    'code' in value &&
    'message' in value &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  ) {
    return value as GithubError;
  }
  return null;
}
