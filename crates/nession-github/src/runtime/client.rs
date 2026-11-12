//! The typed, read-only GitHub client.
//!
//! Fixed GET operations only. The Web never supplies a host, owner, path or
//! query; each method builds its URL from the resolved identity and typed
//! filters. Redirects are refused, responses and time are bounded, and error
//! messages never contain credentials or response bodies.

use std::collections::HashMap;
use std::time::Duration;

use reqwest::header::HeaderMap;
use reqwest::{Client, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::protocol::issue_detail::{GithubIssueDetailV1, IssueDetailOkV1};
use crate::protocol::issues::{GithubIssueSummaryV1, IssueStateFilterV1, IssuesOkV1};
use crate::protocol::pull_request_detail::{GithubPullRequestDetailV1, PullRequestDetailOkV1};
use crate::protocol::pull_requests::{
    BranchRelationV1, GithubBaseRefV1, GithubHeadRefV1, GithubPullRequestSummaryV1,
    PullRequestStateFilterV1, PullRequestsOkV1,
};
use crate::protocol::repository::RepositoryOkV1;
use crate::protocol::workflows::{
    GithubWorkflowV1, RunScopeV1, WorkflowRunStatusV1, WorkflowRunV1, WorkflowStateV1,
    WorkflowsOkV1,
};
use crate::protocol::{GithubErrorCodeV1, GithubLabelV1, GithubUserV1};
use crate::runtime::remote::{branch_relation, GithubIdentity};

const DEFAULT_LIMIT: u32 = 20;
const MAX_LIMIT: u32 = 50;
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubError {
    pub code: GithubErrorCodeV1,
    pub message: String,
    pub retry_after_seconds: Option<u64>,
}

impl GithubError {
    pub fn new(code: GithubErrorCodeV1, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retry_after_seconds: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct ApiUser {
    login: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiLabel {
    name: String,
    #[serde(default)]
    color: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiIssue {
    number: u64,
    title: String,
    state: String,
    user: Option<ApiUser>,
    #[serde(default)]
    labels: Vec<ApiLabel>,
    #[serde(default)]
    assignees: Vec<ApiUser>,
    updated_at: String,
    created_at: String,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiRepoRef {
    name: String,
    owner: ApiUser,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiHead {
    #[serde(rename = "ref")]
    ref_name: String,
    sha: String,
    #[serde(default)]
    repo: Option<ApiRepoRef>,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiBase {
    #[serde(rename = "ref")]
    ref_name: String,
    sha: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiPull {
    number: u64,
    title: String,
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    merged_at: Option<String>,
    user: Option<ApiUser>,
    head: ApiHead,
    base: ApiBase,
    updated_at: String,
    created_at: String,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiWorkflow {
    id: u64,
    name: String,
    path: String,
    state: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiWorkflows {
    #[serde(default)]
    workflows: Vec<ApiWorkflow>,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiRun {
    id: u64,
    workflow_id: u64,
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    head_branch: Option<String>,
    head_sha: String,
    event: String,
    created_at: String,
    updated_at: String,
    html_url: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiRuns {
    #[serde(default)]
    workflow_runs: Vec<ApiRun>,
}

fn user(user: Option<ApiUser>) -> GithubUserV1 {
    GithubUserV1 {
        login: user.map(|user| user.login).unwrap_or_default(),
    }
}

fn labels(labels: Vec<ApiLabel>) -> Vec<GithubLabelV1> {
    labels
        .into_iter()
        .map(|label| GithubLabelV1 {
            name: label.name,
            color: label.color,
        })
        .collect()
}

fn status(status: &str) -> WorkflowRunStatusV1 {
    match status {
        "queued" => WorkflowRunStatusV1::Queued,
        "in_progress" => WorkflowRunStatusV1::InProgress,
        "completed" => WorkflowRunStatusV1::Completed,
        _ => WorkflowRunStatusV1::Unknown,
    }
}

fn workflow_state(state: &str) -> WorkflowStateV1 {
    match state {
        "active" => WorkflowStateV1::Active,
        "disabled_manually" | "disabled_inactivity" => WorkflowStateV1::Disabled,
        _ => WorkflowStateV1::Unknown,
    }
}

fn map_run(run: ApiRun) -> WorkflowRunV1 {
    WorkflowRunV1 {
        id: run.id,
        status: status(&run.status),
        conclusion: run.conclusion,
        branch: run.head_branch,
        sha: run.head_sha,
        event: run.event,
        created_at: run.created_at,
        updated_at: run.updated_at,
        url: run.html_url,
    }
}

fn clamp_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn page(cursor: Option<&str>) -> Result<u32, GithubError> {
    match cursor {
        None => Ok(1),
        Some(cursor) => cursor
            .parse::<u32>()
            .ok()
            .filter(|page| *page >= 1)
            .ok_or_else(|| GithubError::new(GithubErrorCodeV1::ApiError, "invalid continuation")),
    }
}

/// One read-only GitHub client.
pub struct GithubClient {
    http: Result<Client, String>,
    api_base: Option<Url>,
    token: Option<String>,
    auth_fingerprint: String,
    max_bytes: usize,
}

impl GithubClient {
    /// Build from the Agent's environment: a host-appropriate token and the
    /// fixed GitHub API origin. An absent token is not a construction failure;
    /// operations answer `not_authenticated`.
    pub fn from_env() -> Self {
        let token = std::env::var("GITHUB_TOKEN")
            .or_else(|_| std::env::var("GH_TOKEN"))
            .ok()
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty());
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .user_agent("nession-agent")
            .build();
        let api_base = Url::parse("https://api.github.com/").ok();
        Self::with_parts(http, api_base, token, MAX_RESPONSE_BYTES)
    }

    /// A client over an explicit origin, for tests and for a future approved
    /// Enterprise origin. Origin is configuration, never client input.
    pub fn new(api_base: Url, token: Option<String>) -> Self {
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .user_agent("nession-agent")
            .build();
        Self::with_parts(http, Some(api_base), token, MAX_RESPONSE_BYTES)
    }

    fn with_parts(
        http: Result<Client, reqwest::Error>,
        api_base: Option<Url>,
        token: Option<String>,
        max_bytes: usize,
    ) -> Self {
        let auth_fingerprint = token
            .as_ref()
            .map(|token| {
                let digest = Sha256::digest(token.as_bytes());
                format!("{digest:x}")[..16].to_string()
            })
            .unwrap_or_else(|| "anonymous".to_string());
        Self {
            http: http.map_err(|error| error.to_string()),
            api_base,
            token,
            auth_fingerprint,
            max_bytes,
        }
    }

    pub fn authenticated(&self) -> bool {
        self.token.is_some()
    }

    /// A stable identity for cache keys. Never the token itself.
    pub fn auth_fingerprint(&self) -> &str {
        &self.auth_fingerprint
    }

    /// The resolved repository's local identity answer. No network call.
    pub fn repository(
        &self,
        identity: &GithubIdentity,
        remote_name: &str,
        branch: Option<String>,
        choices: Vec<crate::protocol::GithubRemoteChoiceV1>,
    ) -> RepositoryOkV1 {
        RepositoryOkV1 {
            resolution: crate::protocol::repository::RepositoryStateV1::Resolved,
            repository: Some(identity.reference(remote_name)),
            branch,
            choices,
            authenticated: self.authenticated(),
        }
    }

    pub async fn issues(
        &self,
        identity: &GithubIdentity,
        state: IssueStateFilterV1,
        limit: Option<u32>,
        cursor: Option<&str>,
    ) -> Result<IssuesOkV1, GithubError> {
        let limit = clamp_limit(limit);
        let page = page(cursor)?;
        let state = match state {
            IssueStateFilterV1::Open => "open",
            IssueStateFilterV1::Closed => "closed",
            IssueStateFilterV1::All => "all",
        };
        let mut url = self.repo_url(identity)?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| GithubError::new(GithubErrorCodeV1::ApiError, "invalid API origin"))?;
            segments.extend(["issues"]);
        }
        url.query_pairs_mut()
            .append_pair("state", state)
            .append_pair("per_page", &limit.to_string())
            .append_pair("page", &page.to_string());
        let (body, link) = self.get::<Vec<ApiIssue>>(url).await?;
        let issues = body
            .into_iter()
            .filter(|issue| issue.pull_request.is_none())
            .map(|issue| GithubIssueSummaryV1 {
                number: issue.number,
                title: issue.title,
                state: issue.state,
                author: user(issue.user),
                labels: labels(issue.labels),
                assignees: issue
                    .assignees
                    .into_iter()
                    .map(|user| GithubUserV1 { login: user.login })
                    .collect(),
                updated_at: issue.updated_at,
                url: issue.html_url,
            })
            .collect();
        let has_more = has_next(&link);
        Ok(IssuesOkV1 {
            repository: identity.reference(""),
            issues,
            has_more,
            next_cursor: has_more.then(|| (page + 1).to_string()),
        })
    }

    pub async fn issue_detail(
        &self,
        identity: &GithubIdentity,
        number: u64,
    ) -> Result<IssueDetailOkV1, GithubError> {
        if number == 0 {
            return Err(GithubError::new(
                GithubErrorCodeV1::NotFound,
                "issue not found",
            ));
        }
        let mut url = self.repo_url(identity)?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| GithubError::new(GithubErrorCodeV1::ApiError, "invalid API origin"))?;
            segments.extend(["issues", &number.to_string()]);
        }
        let issue = self.get::<ApiIssue>(url).await?.0;
        if issue.pull_request.is_some() {
            return Err(GithubError::new(
                GithubErrorCodeV1::NotFound,
                "this number is a pull request, not an issue",
            ));
        }
        Ok(IssueDetailOkV1 {
            repository: identity.reference(""),
            issue: GithubIssueDetailV1 {
                number: issue.number,
                title: issue.title,
                state: issue.state,
                author: user(issue.user),
                labels: labels(issue.labels),
                assignees: issue
                    .assignees
                    .into_iter()
                    .map(|user| GithubUserV1 { login: user.login })
                    .collect(),
                created_at: issue.created_at,
                updated_at: issue.updated_at,
                url: issue.html_url,
                body: issue.body.unwrap_or_default(),
            },
        })
    }

    pub async fn pull_requests(
        &self,
        identity: &GithubIdentity,
        state: PullRequestStateFilterV1,
        limit: Option<u32>,
        cursor: Option<&str>,
        branch: Option<&str>,
    ) -> Result<PullRequestsOkV1, GithubError> {
        let limit = clamp_limit(limit);
        let page = page(cursor)?;
        let state = match state {
            PullRequestStateFilterV1::Open => "open",
            PullRequestStateFilterV1::Closed => "closed",
            PullRequestStateFilterV1::All => "all",
        };
        let mut url = self.repo_url(identity)?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| GithubError::new(GithubErrorCodeV1::ApiError, "invalid API origin"))?;
            segments.extend(["pulls"]);
        }
        url.query_pairs_mut()
            .append_pair("state", state)
            .append_pair("per_page", &limit.to_string())
            .append_pair("page", &page.to_string());
        let (body, link) = self.get::<Vec<ApiPull>>(url).await?;
        let mut relation = BranchRelationV1::None;
        let mut current = None;
        let pull_requests: Vec<GithubPullRequestSummaryV1> = body
            .into_iter()
            .map(|pull| {
                let head_owner = pull
                    .head
                    .repo
                    .as_ref()
                    .map(|repo| repo.owner.login.clone())
                    .unwrap_or_default();
                let head_repo = pull
                    .head
                    .repo
                    .as_ref()
                    .map(|repo| repo.name.clone())
                    .unwrap_or_default();
                if let Some(branch) = branch {
                    if branch_relation(
                        identity,
                        &head_owner,
                        &head_repo,
                        &pull.head.ref_name,
                        branch,
                    ) {
                        if relation == BranchRelationV1::Matched {
                            relation = BranchRelationV1::Ambiguous;
                            current = None;
                        } else if relation == BranchRelationV1::None {
                            relation = BranchRelationV1::Matched;
                            current = Some(pull.number);
                        }
                    }
                }
                GithubPullRequestSummaryV1 {
                    number: pull.number,
                    title: pull.title,
                    state: pull.state,
                    draft: pull.draft,
                    merged: pull.merged_at.is_some(),
                    author: user(pull.user),
                    head_ref_name: pull.head.ref_name.clone(),
                    base_ref_name: pull.base.ref_name.clone(),
                    base: GithubBaseRefV1 {
                        ref_name: pull.base.ref_name.clone(),
                        sha: pull.base.sha.clone(),
                    },
                    head: GithubHeadRefV1 {
                        owner: head_owner,
                        repo: head_repo,
                        ref_name: pull.head.ref_name,
                        sha: pull.head.sha,
                    },
                    updated_at: pull.updated_at,
                    url: pull.html_url,
                }
            })
            .collect();
        let has_more = has_next(&link);
        Ok(PullRequestsOkV1 {
            repository: identity.reference(""),
            pull_requests,
            current_branch: relation,
            current_branch_pr: current,
            has_more,
            next_cursor: has_more.then(|| (page + 1).to_string()),
        })
    }

    pub async fn pull_request_detail(
        &self,
        identity: &GithubIdentity,
        number: u64,
    ) -> Result<PullRequestDetailOkV1, GithubError> {
        if number == 0 {
            return Err(GithubError::new(
                GithubErrorCodeV1::NotFound,
                "pull request not found",
            ));
        }
        let mut url = self.repo_url(identity)?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| GithubError::new(GithubErrorCodeV1::ApiError, "invalid API origin"))?;
            segments.extend(["pulls", &number.to_string()]);
        }
        let pull = self.get::<ApiPull>(url).await?.0;
        let head_owner = pull
            .head
            .repo
            .as_ref()
            .map(|repo| repo.owner.login.clone())
            .unwrap_or_default();
        let head_repo = pull
            .head
            .repo
            .as_ref()
            .map(|repo| repo.name.clone())
            .unwrap_or_default();
        Ok(PullRequestDetailOkV1 {
            repository: identity.reference(""),
            pull_request: GithubPullRequestDetailV1 {
                number: pull.number,
                title: pull.title,
                state: pull.state,
                draft: pull.draft,
                merged: pull.merged_at.is_some(),
                merged_at: pull.merged_at,
                author: user(pull.user),
                head_ref_name: pull.head.ref_name.clone(),
                base_ref_name: pull.base.ref_name.clone(),
                base: GithubBaseRefV1 {
                    ref_name: pull.base.ref_name.clone(),
                    sha: pull.base.sha.clone(),
                },
                head: GithubHeadRefV1 {
                    owner: head_owner,
                    repo: head_repo,
                    ref_name: pull.head.ref_name,
                    sha: pull.head.sha,
                },
                created_at: pull.created_at,
                updated_at: pull.updated_at,
                url: pull.html_url,
                body: pull.body.unwrap_or_default(),
            },
        })
    }

    pub async fn workflows(
        &self,
        identity: &GithubIdentity,
        scope: RunScopeV1,
        limit: Option<u32>,
        cursor: Option<&str>,
        branch: Option<&str>,
    ) -> Result<WorkflowsOkV1, GithubError> {
        let limit = clamp_limit(limit);
        let page = page(cursor)?;
        let mut url = self.repo_url(identity)?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| GithubError::new(GithubErrorCodeV1::ApiError, "invalid API origin"))?;
            segments.extend(["actions", "workflows"]);
        }
        url.query_pairs_mut()
            .append_pair("per_page", &limit.to_string())
            .append_pair("page", &page.to_string());
        let (workflows, link) = self.get::<ApiWorkflows>(url).await?;

        let mut runs_url = self.repo_url(identity)?;
        {
            let mut segments = runs_url
                .path_segments_mut()
                .map_err(|_| GithubError::new(GithubErrorCodeV1::ApiError, "invalid API origin"))?;
            segments.extend(["actions", "runs"]);
        }
        runs_url.query_pairs_mut().append_pair("per_page", "100");
        if scope == RunScopeV1::Branch {
            let Some(branch) = branch else {
                return Err(GithubError::new(
                    GithubErrorCodeV1::ApiError,
                    "the current branch is unavailable",
                ));
            };
            runs_url.query_pairs_mut().append_pair("branch", branch);
        }
        let mut latest: HashMap<u64, WorkflowRunV1> = HashMap::new();
        let (runs, _) = self.get::<ApiRuns>(runs_url).await?;
        for run in runs.workflow_runs {
            let mapped = map_run(run.clone());
            latest.entry(run.workflow_id).or_insert(mapped);
        }

        let has_more = has_next(&link);
        Ok(WorkflowsOkV1 {
            repository: identity.reference(""),
            scope,
            branch: (scope == RunScopeV1::Branch).then(|| branch.unwrap_or_default().to_string()),
            workflows: workflows
                .workflows
                .into_iter()
                .map(|workflow| GithubWorkflowV1 {
                    id: workflow.id,
                    name: workflow.name,
                    path: workflow.path,
                    state: workflow_state(&workflow.state),
                    latest_run: latest.remove(&workflow.id),
                })
                .collect(),
            has_more,
            next_cursor: has_more.then(|| (page + 1).to_string()),
        })
    }

    fn repo_url(&self, identity: &GithubIdentity) -> Result<Url, GithubError> {
        let mut url = self
            .api_base
            .as_ref()
            .ok_or_else(|| {
                GithubError::new(
                    GithubErrorCodeV1::ClientUnavailable,
                    "GitHub client unavailable",
                )
            })?
            .clone();
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| GithubError::new(GithubErrorCodeV1::ApiError, "invalid API origin"))?;
            segments.extend(["repos", &identity.owner, &identity.repo]);
        }
        Ok(url)
    }

    async fn get<T: DeserializeOwned>(&self, url: Url) -> Result<(T, Option<String>), GithubError> {
        let client = self.http.as_ref().map_err(|_| {
            GithubError::new(
                GithubErrorCodeV1::ClientUnavailable,
                "GitHub client unavailable",
            )
        })?;
        if self.api_base.as_ref().and_then(Url::host_str) != url.host_str() {
            return Err(GithubError::new(
                GithubErrorCodeV1::HostNotAllowed,
                "the GitHub API host is not approved",
            ));
        }
        let mut request = client.get(url.clone());
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(map_request_error)?;
        let status = response.status();
        let headers = response.headers().clone();
        if status.is_redirection() {
            return Err(GithubError::new(
                GithubErrorCodeV1::HostNotAllowed,
                "a GitHub redirect was refused",
            ));
        }
        let body = read_body(response, self.max_bytes).await?;
        if !status.is_success() {
            return Err(map_status(status, &headers, &body));
        }
        let parsed = serde_json::from_slice::<T>(&body).map_err(|_| {
            GithubError::new(
                GithubErrorCodeV1::MalformedResponse,
                "GitHub returned a malformed response",
            )
        })?;
        Ok((
            parsed,
            headers
                .get("link")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
        ))
    }
}

fn map_request_error(error: reqwest::Error) -> GithubError {
    if error.is_timeout() {
        GithubError::new(GithubErrorCodeV1::Timeout, "the GitHub request timed out")
    } else if error.is_connect() {
        GithubError::new(
            GithubErrorCodeV1::NetworkUnavailable,
            "GitHub could not be reached",
        )
    } else {
        GithubError::new(GithubErrorCodeV1::ApiError, "the GitHub request failed")
    }
}

fn map_status(status: StatusCode, headers: &HeaderMap, body: &[u8]) -> GithubError {
    let message = match status.as_u16() {
        401 => "GitHub rejected the Agent credential",
        403 => {
            let limited = headers
                .get("x-ratelimit-remaining")
                .and_then(|value| value.to_str().ok())
                .map(|value| value == "0")
                .unwrap_or(false)
                || std::str::from_utf8(body)
                    .map(|body| body.to_ascii_lowercase().contains("rate limit"))
                    .unwrap_or(false);
            if limited {
                let retry = headers
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok());
                let mut error =
                    GithubError::new(GithubErrorCodeV1::RateLimited, "GitHub rate limit exceeded");
                error.retry_after_seconds = retry;
                return error;
            }
            "GitHub denied access to this repository"
        }
        404 => "GitHub could not find the requested resource",
        429 => {
            let retry = headers
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok());
            let mut error =
                GithubError::new(GithubErrorCodeV1::RateLimited, "GitHub rate limit exceeded");
            error.retry_after_seconds = retry;
            return error;
        }
        _ => "GitHub returned an API error",
    };
    let code = match status.as_u16() {
        401 => GithubErrorCodeV1::NotAuthenticated,
        403 => GithubErrorCodeV1::AccessDenied,
        404 => GithubErrorCodeV1::NotFound,
        _ => GithubErrorCodeV1::ApiError,
    };
    GithubError::new(code, message)
}

async fn read_body(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, GithubError> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(map_request_error)? {
        if body.len() + chunk.len() > max {
            return Err(GithubError::new(
                GithubErrorCodeV1::ApiError,
                "the GitHub response exceeded the byte budget",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn has_next(link: &Option<String>) -> bool {
    link.as_deref()
        .map(|link| link.contains("rel=\"next\""))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    struct FakeResponse {
        status: u16,
        headers: Vec<(String, String)>,
        body: String,
    }

    impl FakeResponse {
        fn json(status: u16, body: serde_json::Value) -> Self {
            Self {
                status,
                headers: vec![("content-type".into(), "application/json".into())],
                body: body.to_string(),
            }
        }

        fn empty(status: u16) -> Self {
            Self {
                status,
                headers: Vec::new(),
                body: String::new(),
            }
        }
    }

    struct FakeGithub {
        base: Url,
        requests: Arc<Mutex<Vec<String>>>,
    }

    async fn fake_github(responses: Vec<FakeResponse>) -> FakeGithub {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        tokio::spawn(async move {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut buffer = vec![0u8; 8192];
                let read = stream.read(&mut buffer).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                recorded.lock().unwrap().push(request);
                let reason = match response.status {
                    200 => "OK",
                    302 => "Found",
                    401 => "Unauthorized",
                    403 => "Forbidden",
                    404 => "Not Found",
                    _ => "Error",
                };
                let mut head = format!(
                    "HTTP/1.1 {} {reason}\r\nconnection: close\r\n",
                    response.status
                );
                for (name, value) in &response.headers {
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                head.push_str(&format!("content-length: {}\r\n\r\n", response.body.len()));
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(response.body.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        FakeGithub {
            base: Url::parse(&format!("http://{address}/")).unwrap(),
            requests,
        }
    }

    fn identity() -> GithubIdentity {
        GithubIdentity {
            host: "github.com".into(),
            owner: "acme".into(),
            repo: "repo".into(),
        }
    }

    #[test]
    fn limits_are_clamped_and_cursors_are_opaque_numbers() {
        assert_eq!(clamp_limit(None), DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(500)), MAX_LIMIT);
        assert_eq!(page(None).unwrap(), 1);
        assert!(page(Some("2")).is_ok());
        assert!(page(Some("0")).is_err());
        assert!(page(Some("https://evil")).is_err());
    }

    #[test]
    fn next_link_detection_does_not_treat_prev_as_next() {
        assert!(has_next(&Some(
            "<https://api.github.com/x?page=2>; rel=\"next\", <https://api.github.com/x?page=1>; rel=\"prev\"".into()
        )));
        assert!(!has_next(&Some(
            "<https://api.github.com/x?page=1>; rel=\"prev\"".into()
        )));
        assert!(!has_next(&None));
    }

    #[test]
    fn auth_fingerprint_is_stable_and_never_the_token() {
        let client = GithubClient::with_parts(
            Ok(Client::new()),
            Some(Url::parse("https://api.github.com/").unwrap()),
            Some("secret-token".into()),
            1024,
        );
        assert_ne!(client.auth_fingerprint(), "secret-token");
        assert_eq!(client.auth_fingerprint().len(), 16);
        assert!(client.authenticated());
        let anonymous = GithubClient::with_parts(
            Ok(Client::new()),
            Some(Url::parse("https://api.github.com/").unwrap()),
            None,
            1024,
        );
        assert_eq!(anonymous.auth_fingerprint(), "anonymous");
        assert!(!anonymous.authenticated());
    }

    #[test]
    fn statuses_map_to_distinct_codes() {
        let headers = HeaderMap::new();
        assert_eq!(
            map_status(StatusCode::UNAUTHORIZED, &headers, b"").code,
            GithubErrorCodeV1::NotAuthenticated
        );
        assert_eq!(
            map_status(StatusCode::NOT_FOUND, &headers, b"").code,
            GithubErrorCodeV1::NotFound
        );
        assert_eq!(
            map_status(StatusCode::FORBIDDEN, &headers, b"nope").code,
            GithubErrorCodeV1::AccessDenied
        );
        let mut limited = HeaderMap::new();
        limited.insert("x-ratelimit-remaining", "0".parse().unwrap());
        assert_eq!(
            map_status(StatusCode::FORBIDDEN, &limited, b"").code,
            GithubErrorCodeV1::RateLimited
        );
    }
    #[tokio::test]
    async fn issues_filters_pr_shaped_records_and_honours_the_next_link() {
        let server = fake_github(vec![
            FakeResponse {
                status: 200,
                headers: vec![
                    ("content-type".into(), "application/json".into()),
                    (
                        "link".into(),
                        "<https://api.github.com/repos/acme/repo/issues?page=2>; rel=\"next\""
                            .into(),
                    ),
                ],
                body: serde_json::json!([
                    {"number": 1, "title": "Issue", "state": "open", "user": {"login": "dev"},
                     "labels": [{"name": "bug", "color": "ff0000"}], "assignees": [],
                     "updated_at": "2026-01-01T00:00:00Z", "created_at": "2026-01-01T00:00:00Z",
                     "html_url": "https://github.com/acme/repo/issues/1"},
                    {"number": 2, "title": "PR-shaped", "state": "open", "user": {"login": "dev"},
                     "labels": [], "assignees": [], "updated_at": "2026-01-01T00:00:00Z",
                     "created_at": "2026-01-01T00:00:00Z",
                     "html_url": "https://github.com/acme/repo/pull/2", "pull_request": {}}
                ])
                .to_string(),
            },
            FakeResponse::json(200, serde_json::json!([])),
        ])
        .await;
        let client = GithubClient::new(server.base, Some("secret".into()));
        let first = client
            .issues(&identity(), IssueStateFilterV1::Open, Some(20), None)
            .await
            .unwrap();
        assert_eq!(first.issues.len(), 1);
        assert_eq!(first.issues[0].number, 1);
        assert_eq!(first.issues[0].labels[0].name, "bug");
        assert!(first.has_more);
        assert_eq!(first.next_cursor.as_deref(), Some("2"));
        let second = client
            .issues(&identity(), IssueStateFilterV1::Open, Some(20), Some("2"))
            .await
            .unwrap();
        assert_eq!(second.issues.len(), 0);
        assert!(!second.has_more);
        let requests = server.requests.lock().unwrap();
        assert!(
            requests[0].starts_with("GET /repos/acme/repo/issues?state=open&per_page=20&page=1")
        );
        assert!(requests[0]
            .to_ascii_lowercase()
            .contains("authorization: bearer secret"));
        assert!(requests[1].contains("page=2"));
    }

    #[tokio::test]
    async fn issue_detail_returns_the_full_body_and_rejects_a_pr_shaped_number() {
        let server = fake_github(vec![
            FakeResponse::json(
                200,
                serde_json::json!({
                    "number": 1290, "title": "Detail", "state": "open", "user": {"login": "dev"},
                    "labels": [], "assignees": [], "updated_at": "2026-01-02T00:00:00Z",
                    "created_at": "2026-01-01T00:00:00Z", "body": "**full** body",
                    "html_url": "https://github.com/acme/repo/issues/1290"
                }),
            ),
            FakeResponse::json(
                200,
                serde_json::json!({
                    "number": 2, "title": "PR", "state": "open", "user": {"login": "dev"},
                    "labels": [], "assignees": [], "updated_at": "2026-01-02T00:00:00Z",
                    "created_at": "2026-01-01T00:00:00Z", "body": "x",
                    "html_url": "https://github.com/acme/repo/pull/2", "pull_request": {}
                }),
            ),
        ])
        .await;
        let client = GithubClient::new(server.base, Some("secret".into()));
        let detail = client.issue_detail(&identity(), 1290).await.unwrap();
        assert_eq!(detail.issue.body, "**full** body");
        let wrong = client.issue_detail(&identity(), 2).await.unwrap_err();
        assert_eq!(wrong.code, GithubErrorCodeV1::NotFound);
    }

    #[tokio::test]
    async fn pulls_match_the_current_branch_by_exact_head_repository_and_ref() {
        let server = fake_github(vec![FakeResponse::json(
            200,
            serde_json::json!([
                {"number": 7, "title": "mine", "state": "open", "draft": false,
                 "user": {"login": "dev"}, "updated_at": "2026-01-01T00:00:00Z",
                 "created_at": "2026-01-01T00:00:00Z", "html_url": "https://github.com/acme/repo/pull/7",
                 "head": {"ref": "feature/x", "sha": "aaa", "repo": {"name": "repo", "owner": {"login": "acme"}}},
                 "base": {"ref": "main", "sha": "bbb"}},
                {"number": 8, "title": "fork", "state": "open", "draft": true,
                 "user": {"login": "other"}, "updated_at": "2026-01-01T00:00:00Z",
                 "created_at": "2026-01-01T00:00:00Z", "html_url": "https://github.com/acme/repo/pull/8",
                 "head": {"ref": "feature/x", "sha": "ccc", "repo": {"name": "repo", "owner": {"login": "fork"}}},
                 "base": {"ref": "main", "sha": "bbb"}}
            ]),
        )])
        .await;
        let client = GithubClient::new(server.base, Some("secret".into()));
        let pulls = client
            .pull_requests(
                &identity(),
                PullRequestStateFilterV1::Open,
                None,
                None,
                Some("feature/x"),
            )
            .await
            .unwrap();
        assert_eq!(pulls.pull_requests.len(), 2);
        assert_eq!(pulls.current_branch, BranchRelationV1::Matched);
        assert_eq!(pulls.current_branch_pr, Some(7));
        assert!(pulls.pull_requests[1].draft);
    }

    #[tokio::test]
    async fn workflows_group_the_latest_run_and_scope_the_runs_request_to_the_branch() {
        let server = fake_github(vec![
            FakeResponse::json(
                200,
                serde_json::json!({"workflows": [
                    {"id": 1, "name": "CI", "path": ".github/workflows/ci.yml", "state": "active"},
                    {"id": 2, "name": "E2E", "path": ".github/workflows/e2e.yml", "state": "disabled_manually"}
                ]}),
            ),
            FakeResponse::json(
                200,
                serde_json::json!({"workflow_runs": [
                    {"id": 10, "workflow_id": 1, "status": "completed", "conclusion": "success",
                     "head_branch": "feature/x", "head_sha": "aaa", "event": "pull_request",
                     "created_at": "2026-01-02T00:00:00Z", "updated_at": "2026-01-02T00:01:00Z",
                     "html_url": "https://github.com/acme/repo/actions/runs/10"},
                    {"id": 11, "workflow_id": 2, "status": "queued", "head_branch": "feature/x",
                     "head_sha": "bbb", "event": "pull_request", "created_at": "2026-01-02T00:00:00Z",
                     "updated_at": "2026-01-02T00:00:30Z",
                     "html_url": "https://github.com/acme/repo/actions/runs/11"},
                    {"id": 12, "workflow_id": 99, "status": "completed", "conclusion": "failure",
                     "head_branch": "other", "head_sha": "ccc", "event": "push",
                     "created_at": "2026-01-02T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z",
                     "html_url": "https://github.com/acme/repo/actions/runs/12"}
                ]}),
            ),
        ])
        .await;
        let client = GithubClient::new(server.base, Some("secret".into()));
        let workflows = client
            .workflows(
                &identity(),
                RunScopeV1::Branch,
                None,
                None,
                Some("feature/x"),
            )
            .await
            .unwrap();
        assert_eq!(workflows.workflows.len(), 2);
        assert_eq!(
            workflows.workflows[0].latest_run.as_ref().unwrap().status,
            WorkflowRunStatusV1::Completed
        );
        assert_eq!(workflows.workflows[1].state, WorkflowStateV1::Disabled);
        assert_eq!(
            workflows.workflows[1].latest_run.as_ref().unwrap().status,
            WorkflowRunStatusV1::Queued
        );
        let requests = server.requests.lock().unwrap();
        assert!(requests[1].contains("branch=feature%2Fx"));
    }

    #[tokio::test]
    async fn status_errors_are_typed_and_a_redirect_is_never_followed() {
        let unauthorized = fake_github(vec![FakeResponse::empty(401)]).await;
        let client = GithubClient::new(unauthorized.base, Some("secret".into()));
        let error = client
            .issues(&identity(), IssueStateFilterV1::Open, None, None)
            .await
            .unwrap_err();
        assert_eq!(error.code, GithubErrorCodeV1::NotAuthenticated);

        let redirect = fake_github(vec![FakeResponse {
            status: 302,
            headers: vec![("location".into(), "https://evil.example/".into())],
            body: String::new(),
        }])
        .await;
        let client = GithubClient::new(redirect.base, Some("secret".into()));
        let error = client
            .issues(&identity(), IssueStateFilterV1::Open, None, None)
            .await
            .unwrap_err();
        assert_eq!(error.code, GithubErrorCodeV1::HostNotAllowed);
        assert_eq!(redirect.requests.lock().unwrap().len(), 1);
    }
}
