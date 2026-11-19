//! The Agent-side extension that serves the six `github.*` units.
//!
//! Every request re-resolves the Session's live working directory and its Git
//! remotes. The client accepts only the resolved identity; it never accepts a
//! host, owner, repo or path from the Web.

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use nession_common::extension::AgentExtension;
use nession_common::session_env::SessionEnvironment;
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
use crate::runtime::credentials::effective_token;
use crate::runtime::remote::{choices, select_remote, GithubRemote, Selection};
use crate::runtime::repository_context::read_repository_context;

pub struct GithubAgentExtension {
    bin: String,
    resolve_workdir: Arc<dyn WorkdirResolver>,
    /// The API origin and HTTP pool. The credential is attached per request
    /// (#4080) — freezing the Agent's process environment here would give
    /// every Session the Agent's identity.
    transport: Arc<GithubClient>,
    /// How this host resolves a Session's explicit environment overrides.
    session_env: Arc<dyn SessionEnvironment>,
    cache: GithubCache,
}

impl GithubAgentExtension {
    pub fn new(
        bin: impl Into<String>,
        resolve_workdir: Arc<dyn WorkdirResolver>,
        transport: Arc<GithubClient>,
        session_env: Arc<dyn SessionEnvironment>,
    ) -> Self {
        Self {
            bin: bin.into(),
            resolve_workdir,
            transport,
            session_env,
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
        // The Session's explicit overrides, materialized by its Environment
        // Binding. Failing to verify them is not "no overrides": a Session
        // that bound `GITHUB_TOKEN` must never silently fall back to the
        // Agent's credential because its binding record was unreadable.
        let overrides = self
            .session_env
            .session_overrides(&target.session, None)
            .await
            .map_err(|error| {
                GithubError::new(
                    GithubErrorCodeV1::ClientUnavailable,
                    format!(
                        "this Session's environment could not be verified: {}",
                        error.message()
                    ),
                )
            })?;
        let cmd = GitCmd::new(self.bin.clone(), workdir).with_environment(overrides.clone());
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
        // Scope precedence precedes alias precedence over the *explicit*
        // Session values; the Agent environment is only the inherited
        // fallback (#4080).
        let client = self
            .transport
            .with_token(effective_token(&overrides, self.session_env.as_ref()));
        Ok(Resolved {
            context,
            selection,
            remotes,
            client,
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
                authenticated: resolved.client.authenticated(),
            },
            Selection::NoRemote => RepositoryOkV1 {
                resolution: RepositoryStateV1::NoRemote,
                repository: None,
                branch,
                choices: Vec::new(),
                authenticated: resolved.client.authenticated(),
            },
            Selection::Ambiguous(remotes) => RepositoryOkV1 {
                resolution: RepositoryStateV1::Ambiguous,
                repository: None,
                branch,
                choices: choices(remotes),
                authenticated: resolved.client.authenticated(),
            },
            Selection::HostNotAllowed(remotes) => RepositoryOkV1 {
                resolution: RepositoryStateV1::HostNotAllowed,
                repository: None,
                branch,
                choices: choices(remotes),
                authenticated: resolved.client.authenticated(),
            },
        }
    }
}

struct Resolved {
    context: nession_git::RepositoryContext,
    selection: Selection,
    remotes: Vec<GithubRemote>,
    /// The client authenticated for *this* Session's effective credential.
    client: GithubClient,
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
        if !resolved.client.authenticated() {
            return Err(GithubError::new(
                GithubErrorCodeV1::NotAuthenticated,
                "this Session has no GitHub credential",
            ));
        }
        Ok((resolved, remote))
    }

    fn key(
        &self,
        target: &SessionTargetV1,
        remote: &GithubRemote,
        branch: Option<&str>,
        client: &GithubClient,
        op: &str,
        params: &str,
    ) -> String {
        format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{}",
            target.session,
            remote.remote_name,
            remote.identity.source_url(),
            branch.unwrap_or(""),
            client.auth_fingerprint(),
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
            &resolved.client,
            "issues",
            &serde_json::json!({"state": request.state, "limit": request.limit, "cursor": request.cursor}).to_string(),
        );
        let value = self
            .cache
            .get_or_fetch(&key, request.refresh.unwrap_or(false), || async {
                let mut data = resolved
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
        let (resolved, remote) = self.target(&request.target).await?;
        let mut data = resolved
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
            &resolved.client,
            "pull_requests",
            &serde_json::json!({"state": request.state, "limit": request.limit, "cursor": request.cursor}).to_string(),
        );
        let value = self
            .cache
            .get_or_fetch(&key, request.refresh.unwrap_or(false), || async {
                let mut data = resolved
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
        let (resolved, remote) = self.target(&request.target).await?;
        let mut data = resolved
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
            &resolved.client,
            "workflows",
            &serde_json::json!({"scope": request.scope, "limit": request.limit, "cursor": request.cursor}).to_string(),
        );
        let value = self
            .cache
            .get_or_fetch(&key, request.refresh.unwrap_or(false), || async {
                let mut data = resolved
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
    use crate::test_support::{fake_github, FakeResponse};
    use async_trait::async_trait;
    use nession_common::session_env::SessionEnvironmentError;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    struct StaticWorkdir(PathBuf);

    #[async_trait]
    impl WorkdirResolver for StaticWorkdir {
        async fn resolve(&self, _session: &str) -> Option<PathBuf> {
            Some(self.0.clone())
        }
    }

    /// A fake host environment: an Agent baseline plus per-Session explicit
    /// overrides that a test can change between requests.
    #[derive(Default)]
    struct FakeSessionEnvironment {
        agent: BTreeMap<String, String>,
        sessions: Mutex<BTreeMap<String, BTreeMap<String, String>>>,
        failure: Option<String>,
    }

    impl FakeSessionEnvironment {
        fn with_agent_token(token: &str) -> Self {
            let mut environment = Self::default();
            environment
                .agent
                .insert("GITHUB_TOKEN".to_string(), token.to_string());
            environment
        }

        fn with_session_token(session: &str, key: &str, value: &str) -> Self {
            let environment = Self::default();
            environment.set_session_token(session, key, value);
            environment
        }

        fn set_session_token(&self, session: &str, key: &str, value: &str) {
            self.sessions
                .lock()
                .unwrap()
                .entry(session.to_string())
                .or_default()
                .insert(key.to_string(), value.to_string());
        }

        fn clear_session(&self, session: &str) {
            self.sessions.lock().unwrap().remove(session);
        }

        fn failing(message: &str) -> Self {
            Self {
                failure: Some(message.to_string()),
                ..Self::default()
            }
        }
    }

    #[async_trait]
    impl SessionEnvironment for FakeSessionEnvironment {
        async fn session_overrides(
            &self,
            session: &str,
            keys: Option<&[&str]>,
        ) -> Result<BTreeMap<String, String>, SessionEnvironmentError> {
            if let Some(message) = &self.failure {
                return Err(SessionEnvironmentError::unavailable(message.clone()));
            }
            Ok(self
                .sessions
                .lock()
                .unwrap()
                .get(session)
                .map(|values| {
                    values
                        .iter()
                        .filter(|(key, _)| keys.is_none_or(|keys| keys.contains(&key.as_str())))
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect()
                })
                .unwrap_or_default())
        }

        fn agent_variable(&self, key: &str) -> Option<String> {
            self.agent.get(key).cloned()
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

    fn extension_with(
        dir: &tempfile::TempDir,
        base: reqwest::Url,
        environment: Arc<FakeSessionEnvironment>,
    ) -> GithubAgentExtension {
        GithubAgentExtension::new(
            "git",
            Arc::new(StaticWorkdir(dir.path().to_path_buf())),
            Arc::new(GithubClient::new(base, None)),
            environment,
        )
    }

    fn extension(dir: &tempfile::TempDir, token: Option<&str>) -> GithubAgentExtension {
        let environment = Arc::new(match token {
            Some(token) => FakeSessionEnvironment::with_agent_token(token),
            None => FakeSessionEnvironment::default(),
        });
        extension_with(
            dir,
            reqwest::Url::parse("http://127.0.0.1:9/").unwrap(),
            environment,
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
        assert_eq!(response["repository"]["remote_name"], "origin");
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

    // ── Session-first credential resolution (#4080) ─────────────────────────

    fn authorization(requests: &[String]) -> Vec<String> {
        requests
            .iter()
            .filter_map(|request| {
                request
                    .lines()
                    .find(|line| line.to_ascii_lowercase().starts_with("authorization:"))
                    .map(str::to_string)
            })
            .collect()
    }

    /// SC-01: a Session credential performs the read with no Agent token, and
    /// the request actually carries that Session's credential.
    #[tokio::test]
    async fn a_session_credential_performs_the_read_without_an_agent_token() {
        let server = fake_github(vec![FakeResponse::json(200, json!([]))]).await;
        let dir = repository(Some("https://github.com/acme/repo.git"));
        let environment = Arc::new(FakeSessionEnvironment::with_session_token(
            "a1:dev",
            "GITHUB_TOKEN",
            "session-token",
        ));
        let response = extension_with(&dir, server.base.clone(), environment)
            .handle_command("github.issues", json!({"session": "a1:dev"}))
            .await
            .unwrap();
        assert_eq!(response["state"], "ok", "{response}");
        let requests = server.recorded();
        assert_eq!(requests.len(), 1, "one authenticated read: {requests:?}");
        assert_eq!(
            authorization(&requests),
            vec!["authorization: Bearer session-token".to_string()]
        );
    }

    /// SC-02: scope precedence precedes alias precedence. The Session's
    /// `GH_TOKEN` must outrank an Agent `GITHUB_TOKEN` the Session inherited.
    #[tokio::test]
    async fn a_session_alias_outranks_an_inherited_agent_primary() {
        let server = fake_github(vec![FakeResponse::json(200, json!([]))]).await;
        let dir = repository(Some("https://github.com/acme/repo.git"));
        let environment = Arc::new(FakeSessionEnvironment::with_agent_token("agent-primary"));
        environment.set_session_token("a1:dev", "GH_TOKEN", "session-secondary");
        let response = extension_with(&dir, server.base.clone(), environment)
            .handle_command("github.issues", json!({"session": "a1:dev"}))
            .await
            .unwrap();
        assert_eq!(response["state"], "ok", "{response}");
        assert_eq!(
            authorization(&server.recorded()),
            vec!["authorization: Bearer session-secondary".to_string()]
        );
    }

    /// SC-02: within the Session scope the primary alias still wins.
    #[tokio::test]
    async fn a_session_primary_outranks_a_session_alias() {
        let server = fake_github(vec![FakeResponse::json(200, json!([]))]).await;
        let dir = repository(Some("https://github.com/acme/repo.git"));
        let environment = Arc::new(FakeSessionEnvironment::default());
        environment.set_session_token("a1:dev", "GITHUB_TOKEN", "session-primary");
        environment.set_session_token("a1:dev", "GH_TOKEN", "session-secondary");
        extension_with(&dir, server.base.clone(), environment)
            .handle_command("github.issues", json!({"session": "a1:dev"}))
            .await
            .unwrap();
        assert_eq!(
            authorization(&server.recorded()),
            vec!["authorization: Bearer session-primary".to_string()]
        );
    }

    /// SC-02: with no Session override the Agent's own credentials still work.
    #[tokio::test]
    async fn agent_credentials_remain_usable_without_a_session_override() {
        let server = fake_github(vec![FakeResponse::json(200, json!([]))]).await;
        let dir = repository(Some("https://github.com/acme/repo.git"));
        let environment = Arc::new(FakeSessionEnvironment::with_agent_token("agent-primary"));
        let response = extension_with(&dir, server.base.clone(), environment)
            .handle_command("github.issues", json!({"session": "a1:dev"}))
            .await
            .unwrap();
        assert_eq!(response["state"], "ok", "{response}");
        assert_eq!(
            authorization(&server.recorded()),
            vec!["authorization: Bearer agent-primary".to_string()]
        );
    }

    /// SC-02: two Sessions with different overrides never share an
    /// authenticated identity — not in the request and not through the cache.
    #[tokio::test]
    async fn concurrent_sessions_do_not_share_authenticated_identity_or_data() {
        let server = fake_github(vec![
            FakeResponse::json(
                200,
                json!([{
                    "number": 11,
                    "title": "one",
                    "state": "open",
                    "updated_at": "2026-01-01T00:00:00Z",
                    "created_at": "2026-01-01T00:00:00Z",
                    "html_url": "https://github.com/acme/repo/issues/11"
                }]),
            ),
            FakeResponse::json(
                200,
                json!([{
                    "number": 22,
                    "title": "two",
                    "state": "open",
                    "updated_at": "2026-01-01T00:00:00Z",
                    "created_at": "2026-01-01T00:00:00Z",
                    "html_url": "https://github.com/acme/repo/issues/22"
                }]),
            ),
        ])
        .await;
        let dir = repository(Some("https://github.com/acme/repo.git"));
        let environment = Arc::new(FakeSessionEnvironment::default());
        environment.set_session_token("a1:one", "GITHUB_TOKEN", "token-one");
        environment.set_session_token("a1:two", "GITHUB_TOKEN", "token-two");
        let extension = extension_with(&dir, server.base.clone(), environment);

        let first = extension
            .handle_command("github.issues", json!({"session": "a1:one"}))
            .await
            .unwrap();
        let second = extension
            .handle_command("github.issues", json!({"session": "a1:two"}))
            .await
            .unwrap();

        assert_eq!(first["issues"][0]["number"], 11, "{first}");
        assert_eq!(second["issues"][0]["number"], 22, "{second}");
        let requests = server.recorded();
        assert_eq!(
            requests.len(),
            2,
            "each identity is fetched once: {requests:?}"
        );
        let authorizations = authorization(&requests);
        assert!(authorizations.contains(&"authorization: Bearer token-one".to_string()));
        assert!(authorizations.contains(&"authorization: Bearer token-two".to_string()));
    }

    /// SC-04: a binding update changes the credential of *subsequent*
    /// requests; removing the override restores the Agent fallback.
    #[tokio::test]
    async fn an_applied_binding_update_is_used_by_the_next_request() {
        let server = fake_github(vec![
            FakeResponse::json(200, json!([])),
            FakeResponse::json(200, json!([])),
        ])
        .await;
        let dir = repository(Some("https://github.com/acme/repo.git"));
        let environment = Arc::new(FakeSessionEnvironment::with_agent_token("agent-primary"));
        let extension = extension_with(&dir, server.base.clone(), Arc::clone(&environment));

        environment.set_session_token("a1:dev", "GITHUB_TOKEN", "bound-token");
        extension
            .handle_command("github.issues", json!({"session": "a1:dev"}))
            .await
            .unwrap();

        environment.clear_session("a1:dev");
        extension
            .handle_command("github.issues", json!({"session": "a1:dev"}))
            .await
            .unwrap();

        assert_eq!(
            authorization(&server.recorded()),
            vec![
                "authorization: Bearer bound-token".to_string(),
                "authorization: Bearer agent-primary".to_string(),
            ]
        );
    }

    /// SC-04: an unverifiable Session environment is an explicit failure —
    /// never a silent fallback to the Agent's credential, and never a place a
    /// credential value can appear.
    #[tokio::test]
    async fn an_unverifiable_session_environment_is_an_explicit_error() {
        let dir = repository(Some("https://github.com/acme/repo.git"));
        let environment = Arc::new(FakeSessionEnvironment::failing(
            "cannot parse the durable binding record for session a1:dev",
        ));
        let response = extension_with(
            &dir,
            reqwest::Url::parse("http://127.0.0.1:9/").unwrap(),
            environment,
        )
        .handle_command("github.issues", json!({"session": "a1:dev"}))
        .await
        .unwrap();
        assert_eq!(response["state"], "error");
        assert_eq!(response["code"], "client_unavailable");
        assert!(
            response["message"]
                .as_str()
                .unwrap()
                .contains("could not be verified"),
            "{response}"
        );
        assert!(
            !serde_json::to_string(&response).unwrap().contains("token"),
            "an environment error must not expose a value: {response}"
        );
    }

    /// SC-04: an explicitly bound empty credential decides the answer. It is
    /// not authenticated and does not silently fall through to the Agent.
    #[tokio::test]
    async fn an_explicitly_empty_session_credential_does_not_fall_back() {
        let dir = repository(Some("https://github.com/acme/repo.git"));
        let environment = Arc::new(FakeSessionEnvironment::with_agent_token("agent-primary"));
        environment.set_session_token("a1:dev", "GH_TOKEN", "");
        let response = extension_with(
            &dir,
            reqwest::Url::parse("http://127.0.0.1:9/").unwrap(),
            environment,
        )
        .handle_command("github.issues", json!({"session": "a1:dev"}))
        .await
        .unwrap();
        assert_eq!(response["state"], "error");
        assert_eq!(response["code"], "not_authenticated");
    }

    /// SC-01/SC-02: the local repository answer reports the Session's
    /// effective authentication, not the Agent's process environment.
    #[tokio::test]
    async fn repository_authentication_reflects_the_session_credential() {
        let dir = repository(Some("https://github.com/acme/repo.git"));
        let bound = Arc::new(FakeSessionEnvironment::with_session_token(
            "a1:dev",
            "GITHUB_TOKEN",
            "session-token",
        ));
        let authenticated = extension_with(
            &dir,
            reqwest::Url::parse("http://127.0.0.1:9/").unwrap(),
            bound,
        )
        .handle_command("github.repository", json!({"session": "a1:dev"}))
        .await
        .unwrap();
        assert_eq!(authenticated["authenticated"], true, "{authenticated}");

        let unbound = extension(&dir, None)
            .handle_command("github.repository", json!({"session": "a1:dev"}))
            .await
            .unwrap();
        assert_eq!(unbound["authenticated"], false, "{unbound}");
    }
}
