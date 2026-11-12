//! The Agent-side extension that serves the six `github.*` units.
//!
//! Every request re-resolves the Session's live working directory and its Git
//! remotes. The client accepts only the resolved identity; it never accepts a
//! host, owner, repo or path from the Web.

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use nession_common::extension::AgentExtension;
use nession_git::{GitCmd, WorkdirResolver};
use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::protocol::issue_detail::IssueDetailRequestV1;
use crate::protocol::issues::IssuesRequestV1;
use crate::protocol::pull_request_detail::PullRequestDetailRequestV1;
use crate::protocol::pull_requests::PullRequestsRequestV1;
use crate::protocol::repository::{RepositoryOkV1, RepositoryRequestV1, RepositoryStateV1};
use crate::protocol::workflows::WorkflowsRequestV1;
use crate::protocol::{GithubErrorCodeV1, GithubResponseV1, SessionTargetV1};
use crate::runtime::cache::GithubCache;
use crate::runtime::client::{GithubClient, GithubError};
use crate::runtime::remote::{choices, select_remote, GithubRemote, Selection};
use crate::runtime::repository_context::read_repository_context;

pub struct GithubAgentExtension {
    bin: String,
    resolve_workdir: Arc<dyn WorkdirResolver>,
    client: Arc<GithubClient>,
    cache: GithubCache,
}

impl GithubAgentExtension {
    pub fn new(
        bin: impl Into<String>,
        resolve_workdir: Arc<dyn WorkdirResolver>,
        client: Arc<GithubClient>,
    ) -> Self {
        Self {
            bin: bin.into(),
            resolve_workdir,
            client,
            cache: GithubCache::new(),
        }
    }

    async fn resolve(&self, target: &SessionTargetV1) -> Result<Resolved, GithubError> {
        let workdir = self
            .resolve_workdir
            .resolve(&target.session)
            .await
            .ok_or_else(|| {
                GithubError::new(
                    GithubErrorCodeV1::NotARepository,
                    "this Session has no live working directory",
                )
            })?;
        let cmd = GitCmd::new(self.bin.clone(), workdir);
        let context = read_repository_context(&cmd).await.map_err(|_| {
            GithubError::new(
                GithubErrorCodeV1::ClientUnavailable,
                "the Session repository could not be read",
            )
        })?;
        let Some(context) = context else {
            return Err(GithubError::new(
                GithubErrorCodeV1::NotARepository,
                "this Session is not in a Git repository",
            ));
        };
        let selection = select_remote(&context, target.remote_name.as_deref());
        let remotes = crate::runtime::remote::discover(&context);
        Ok(Resolved {
            context,
            selection,
            remotes,
        })
    }

    fn response<T: serde::Serialize>(outcome: Result<T, GithubError>) -> Value {
        match outcome {
            Ok(data) => serde_json::to_value(GithubResponseV1::Ok { data }).unwrap_or_else(|_| {
                serde_json::json!({"state":"error","code":"api_error","message":"could not encode the answer"})
            }),
            Err(error) => serde_json::to_value(GithubResponseV1::<Value>::Error {
                code: error.code,
                message: error.message,
                retry_after_seconds: error.retry_after_seconds,
            })
            .unwrap_or_else(|_| {
                serde_json::json!({"state":"error","code":"api_error","message":"could not encode the error"})
            }),
        }
    }

    fn repository_answer(&self, resolved: &Resolved) -> RepositoryOkV1 {
        let context = &resolved.context;
        let branch = context.branch.clone();
        match &resolved.selection {
            Selection::Selected(remote) => RepositoryOkV1 {
                resolution: RepositoryStateV1::Resolved,
                repository: Some(remote.identity.reference(&remote.remote_name)),
                branch,
                choices: choices(&resolved.remotes),
                authenticated: self.client.authenticated(),
            },
            Selection::NoRemote => RepositoryOkV1 {
                resolution: RepositoryStateV1::NoRemote,
                repository: None,
                branch,
                choices: Vec::new(),
                authenticated: self.client.authenticated(),
            },
            Selection::Ambiguous(remotes) => RepositoryOkV1 {
                resolution: RepositoryStateV1::Ambiguous,
                repository: None,
                branch,
                choices: choices(remotes),
                authenticated: self.client.authenticated(),
            },
            Selection::HostNotAllowed(remotes) => RepositoryOkV1 {
                resolution: RepositoryStateV1::HostNotAllowed,
                repository: None,
                branch,
                choices: choices(remotes),
                authenticated: self.client.authenticated(),
            },
        }
    }
}

struct Resolved {
    context: nession_git::RepositoryContext,
    selection: Selection,
    remotes: Vec<GithubRemote>,
}

fn decode<T: DeserializeOwned>(payload: Value) -> Result<T, GithubError> {
    serde_json::from_value(payload)
        .map_err(|_| GithubError::new(GithubErrorCodeV1::ApiError, "malformed request"))
}

#[async_trait]
impl AgentExtension for GithubAgentExtension {
    fn name(&self) -> &'static str {
        "github"
    }

    fn descriptors(&self) -> Result<Vec<ProtocolDescriptor>, IdentityError> {
        crate::protocol::descriptors()
    }

    async fn handle_command(&self, command: &str, payload: Value) -> Result<Value> {
        let response = match command {
            "github.repository" => {
                let request = match decode::<RepositoryRequestV1>(payload) {
                    Ok(request) => request,
                    Err(error) => return Ok(Self::response::<Value>(Err(error))),
                };
                match self.resolve(&request.target).await {
                    Ok(resolved) => Self::response(Ok(self.repository_answer(&resolved))),
                    Err(error) => Self::response::<Value>(Err(error)),
                }
            }
            "github.issues" => {
                let request = match decode::<IssuesRequestV1>(payload) {
                    Ok(request) => request,
                    Err(error) => return Ok(Self::response::<Value>(Err(error))),
                };
                Self::response(self.issues(request).await)
            }
            "github.issue-detail" => {
                let request = match decode::<IssueDetailRequestV1>(payload) {
                    Ok(request) => request,
                    Err(error) => return Ok(Self::response::<Value>(Err(error))),
                };
                Self::response(self.issue_detail(request).await)
            }
            "github.pull-requests" => {
                let request = match decode::<PullRequestsRequestV1>(payload) {
                    Ok(request) => request,
                    Err(error) => return Ok(Self::response::<Value>(Err(error))),
                };
                Self::response(self.pull_requests(request).await)
            }
            "github.pull-request-detail" => {
                let request = match decode::<PullRequestDetailRequestV1>(payload) {
                    Ok(request) => request,
                    Err(error) => return Ok(Self::response::<Value>(Err(error))),
                };
                Self::response(self.pull_request_detail(request).await)
            }
            "github.workflows" => {
                let request = match decode::<WorkflowsRequestV1>(payload) {
                    Ok(request) => request,
                    Err(error) => return Ok(Self::response::<Value>(Err(error))),
                };
                Self::response(self.workflows(request).await)
            }
            other => Self::response::<Value>(Err(GithubError::new(
                GithubErrorCodeV1::ApiError,
                format!("unsupported GitHub operation `{other}`"),
            ))),
        };
        Ok(response)
    }
}

impl GithubAgentExtension {
    async fn target(
        &self,
        target: &SessionTargetV1,
    ) -> Result<(Resolved, GithubRemote), GithubError> {
        let resolved = self.resolve(target).await?;
        let remote = match &resolved.selection {
            Selection::Selected(remote) => remote.clone(),
            Selection::NoRemote => {
                return Err(GithubError::new(
                    GithubErrorCodeV1::NoGithubRemote,
                    "this repository has no GitHub remote",
                ))
            }
            Selection::Ambiguous(_) => {
                return Err(GithubError::new(
                    GithubErrorCodeV1::AmbiguousRemote,
                    "the GitHub remote is ambiguous; choose a discovered remote",
                ))
            }
            Selection::HostNotAllowed(_) => {
                return Err(GithubError::new(
                    GithubErrorCodeV1::HostNotAllowed,
                    "the repository host is not approved for GitHub reads",
                ))
            }
        };
        if remote.identity.host != "github.com" {
            return Err(GithubError::new(
                GithubErrorCodeV1::HostNotAllowed,
                "the repository host is not approved for GitHub reads",
            ));
        }
        if !self.client.authenticated() {
            return Err(GithubError::new(
                GithubErrorCodeV1::NotAuthenticated,
                "the Agent has no GitHub credential",
            ));
        }
        Ok((resolved, remote))
    }

    fn key(
        &self,
        target: &SessionTargetV1,
        remote: &GithubRemote,
        branch: Option<&str>,
        op: &str,
        params: &str,
    ) -> String {
        format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{}",
            target.session,
            remote.remote_name,
            remote.identity.source_url(),
            branch.unwrap_or(""),
            self.client.auth_fingerprint(),
            op,
            params
        )
    }

    async fn issues(
        &self,
        request: IssuesRequestV1,
    ) -> Result<crate::protocol::issues::IssuesOkV1, GithubError> {
        let (resolved, remote) = self.target(&request.target).await?;
        let branch = resolved.context.branch.as_deref();
        let key = self.key(
            &request.target,
            &remote,
            branch,
            "issues",
            &serde_json::json!({"state": request.state, "limit": request.limit, "cursor": request.cursor}).to_string(),
        );
        let value = self
            .cache
            .get_or_fetch(&key, request.refresh.unwrap_or(false), || async {
                let mut data = self
                    .client
                    .issues(
                        &remote.identity,
                        request.state,
                        request.limit,
                        request.cursor.as_deref(),
                    )
                    .await?;
                data.repository = remote.identity.reference(&remote.remote_name);
                serde_json::to_value(data).map_err(|_| {
                    GithubError::new(
                        GithubErrorCodeV1::MalformedResponse,
                        "could not encode GitHub data",
                    )
                })
            })
            .await?;
        serde_json::from_value(value).map_err(|_| {
            GithubError::new(
                GithubErrorCodeV1::MalformedResponse,
                "could not decode cached GitHub data",
            )
        })
    }

    async fn issue_detail(
        &self,
        request: IssueDetailRequestV1,
    ) -> Result<crate::protocol::issue_detail::IssueDetailOkV1, GithubError> {
        let (_, remote) = self.target(&request.target).await?;
        let mut data = self
            .client
            .issue_detail(&remote.identity, request.number)
            .await?;
        data.repository = remote.identity.reference(&remote.remote_name);
        Ok(data)
    }

    async fn pull_requests(
        &self,
        request: PullRequestsRequestV1,
    ) -> Result<crate::protocol::pull_requests::PullRequestsOkV1, GithubError> {
        let (resolved, remote) = self.target(&request.target).await?;
        let branch = resolved.context.branch.as_deref();
        let key = self.key(
            &request.target,
            &remote,
            branch,
            "pull_requests",
            &serde_json::json!({"state": request.state, "limit": request.limit, "cursor": request.cursor}).to_string(),
        );
        let value = self
            .cache
            .get_or_fetch(&key, request.refresh.unwrap_or(false), || async {
                let mut data = self
                    .client
                    .pull_requests(
                        &remote.identity,
                        request.state,
                        request.limit,
                        request.cursor.as_deref(),
                        branch,
                    )
                    .await?;
                data.repository = remote.identity.reference(&remote.remote_name);
                serde_json::to_value(data).map_err(|_| {
                    GithubError::new(
                        GithubErrorCodeV1::MalformedResponse,
                        "could not encode GitHub data",
                    )
                })
            })
            .await?;
        serde_json::from_value(value).map_err(|_| {
            GithubError::new(
                GithubErrorCodeV1::MalformedResponse,
                "could not decode cached GitHub data",
            )
        })
    }

    async fn pull_request_detail(
        &self,
        request: PullRequestDetailRequestV1,
    ) -> Result<crate::protocol::pull_request_detail::PullRequestDetailOkV1, GithubError> {
        let (_, remote) = self.target(&request.target).await?;
        let mut data = self
            .client
            .pull_request_detail(&remote.identity, request.number)
            .await?;
        data.repository = remote.identity.reference(&remote.remote_name);
        Ok(data)
    }

    async fn workflows(
        &self,
        request: WorkflowsRequestV1,
    ) -> Result<crate::protocol::workflows::WorkflowsOkV1, GithubError> {
        let (resolved, remote) = self.target(&request.target).await?;
        let branch = resolved.context.branch.as_deref();
        let key = self.key(
            &request.target,
            &remote,
            branch,
            "workflows",
            &serde_json::json!({"scope": request.scope, "limit": request.limit, "cursor": request.cursor}).to_string(),
        );
        let value = self
            .cache
            .get_or_fetch(&key, request.refresh.unwrap_or(false), || async {
                let mut data = self
                    .client
                    .workflows(
                        &remote.identity,
                        request.scope,
                        request.limit,
                        request.cursor.as_deref(),
                        branch,
                    )
                    .await?;
                data.repository = remote.identity.reference(&remote.remote_name);
                serde_json::to_value(data).map_err(|_| {
                    GithubError::new(
                        GithubErrorCodeV1::MalformedResponse,
                        "could not encode GitHub data",
                    )
                })
            })
            .await?;
        serde_json::from_value(value).map_err(|_| {
            GithubError::new(
                GithubErrorCodeV1::MalformedResponse,
                "could not decode cached GitHub data",
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use serde_json::json;
    use std::path::PathBuf;

    struct StaticWorkdir(PathBuf);

    #[async_trait]
    impl WorkdirResolver for StaticWorkdir {
        async fn resolve(&self, _session: &str) -> Option<PathBuf> {
            Some(self.0.clone())
        }
    }

    fn repository(remote: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?}: {output:?}");
        };
        run(&["init", "-q"]);
        run(&["checkout", "-q", "-b", "feature/x"]);
        if let Some(remote) = remote {
            run(&["remote", "add", "origin", remote]);
        }
        dir
    }

    fn extension(dir: &tempfile::TempDir, token: Option<&str>) -> GithubAgentExtension {
        GithubAgentExtension::new(
            "git",
            Arc::new(StaticWorkdir(dir.path().to_path_buf())),
            Arc::new(GithubClient::new(
                reqwest::Url::parse("http://127.0.0.1:9/").unwrap(),
                token.map(str::to_string),
            )),
        )
    }

    #[tokio::test]
    async fn repository_resolves_from_the_session_live_git_remotes() {
        let dir = repository(Some("git@github.com:acme/repo.git"));
        let response = extension(&dir, None)
            .handle_command("github.repository", json!({"session": "a1:dev"}))
            .await
            .unwrap();
        assert_eq!(response["state"], "ok");
        assert_eq!(response["resolution"], "resolved");
        assert_eq!(response["repository"]["owner"], "acme");
        assert_eq!(response["repository"]["repo"], "repo");
        assert_eq!(response["repository"]["remoteName"], "origin");
        assert_eq!(response["branch"], "feature/x");
        assert_eq!(response["authenticated"], false);
    }

    #[tokio::test]
    async fn a_repository_without_a_github_remote_is_an_ok_no_remote_answer() {
        let dir = repository(None);
        let response = extension(&dir, None)
            .handle_command("github.repository", json!({"session": "a1:dev"}))
            .await
            .unwrap();
        assert_eq!(response["state"], "ok");
        assert_eq!(response["resolution"], "no_remote");
        assert_eq!(response["choices"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn an_api_read_without_a_credential_is_not_authenticated_and_makes_no_request() {
        let dir = repository(Some("https://github.com/acme/repo.git"));
        let response = extension(&dir, None)
            .handle_command("github.issues", json!({"session": "a1:dev"}))
            .await
            .unwrap();
        assert_eq!(response["state"], "error");
        assert_eq!(response["code"], "not_authenticated");
    }

    #[tokio::test]
    async fn a_client_supplied_repository_is_ignored_and_never_reaches_the_request() {
        let dir = repository(Some("https://github.com/acme/repo.git"));
        let response = extension(&dir, None)
            .handle_command(
                "github.repository",
                json!({"session": "a1:dev", "owner": "evil", "repo": "other", "host": "evil.example"}),
            )
            .await
            .unwrap();
        assert_eq!(response["repository"]["owner"], "acme");
        assert_eq!(response["repository"]["repo"], "repo");
    }

    #[tokio::test]
    async fn a_malformed_request_is_a_typed_error_not_a_panic() {
        let dir = repository(None);
        let response = extension(&dir, None)
            .handle_command("github.issues", json!({}))
            .await
            .unwrap();
        assert_eq!(response["state"], "error");
        assert_eq!(response["code"], "api_error");
    }

    #[test]
    fn the_extension_declares_all_six_units() {
        let dir = repository(None);
        let descriptors = extension(&dir, None).descriptors().expect("descriptors");
        assert_eq!(descriptors.len(), 6);
        assert!(descriptors
            .iter()
            .all(|descriptor| descriptor.owner == "nession-github"));
    }
}
