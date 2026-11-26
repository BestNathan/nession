//! #4080 SC-05: a real isolated Agent + tmux Session with a `github.env`-like
//! binding.
//!
//! The Case proves, without any real personal token:
//!
//! - a Session's applied binding selects the GitHub credential for a
//!   Session-addressed request, with no Agent restart;
//! - a later binding revision is used by the next request;
//! - two Sessions with different bindings never share an authenticated
//!   identity;
//! - a Session with no binding falls back to the Agent's own environment —
//!   and the inherited tmux value is *not* mistaken for an explicit Session
//!   override.
//!
//! The GitHub API is a loopback fake. The tmux server is the isolated one the
//! Acceptance Case provides through `NESSION_TMUX_SOCKET`; Session names are
//! unique so a full-suite run that shares the server cannot collide.

#![allow(clippy::expect_used, clippy::indexing_slicing)]

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use nession_agent::session_env::AgentSessionEnvironment;
use nession_agent::tmux::cmd;
use nession_agent::tmux::manager::{SessionBindingInput, SessionManager};
use nession_common::extension::AgentExtension;
use nession_github::{GithubAgentExtension, GithubClient, WorkdirResolver};
use nession_protocol::contracts::env::v1::{EnvFileRef, EnvSnapshot, EnvSource, SessionEnvProfile};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::unique_session_name;

const BINDING_NAME: &str = "github.env";

struct RepoWorkdir(PathBuf);

#[async_trait]
impl WorkdirResolver for RepoWorkdir {
    async fn resolve(&self, _session: &str) -> Option<PathBuf> {
        Some(self.0.clone())
    }
}

fn binding_profile() -> SessionEnvProfile {
    SessionEnvProfile {
        profile: EnvFileRef {
            name: BINDING_NAME.to_string(),
            source: EnvSource::Server,
            agent_id: None,
        },
        phase: "create".to_string(),
        content_hash: None,
    }
}

fn binding_snapshot(token: &str) -> EnvSnapshot {
    EnvSnapshot {
        name: BINDING_NAME.to_string(),
        source: EnvSource::Server,
        agent_id: None,
        vars: vec![("GITHUB_TOKEN".to_string(), token.to_string())],
        warnings: Vec::new(),
    }
}

/// The Agent baseline exactly as `AgentSessionEnvironment` reports it.
fn agent_github_token() -> Option<String> {
    ["GITHUB_TOKEN", "GH_TOKEN"]
        .iter()
        .find_map(|key| std::env::var(key).ok())
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
}

/// A loopback GitHub API that answers `count` requests with an empty Issue
/// list and records the raw request text.
async fn fake_github(count: usize) -> (reqwest::Url, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind fake");
    let address = listener.local_addr().expect("fake address");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&requests);
    tokio::spawn(async move {
        for _ in 0..count {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let mut buffer = vec![0u8; 16 * 1024];
            let read = stream.read(&mut buffer).await.unwrap_or(0);
            recorded
                .lock()
                .await
                .push(String::from_utf8_lossy(&buffer[..read]).to_string());
            let body = "[]";
            let head = format!(
                "HTTP/1.1 200 OK\r\nconnection: close\r\ncontent-type: application/json\r\n\
                 content-length: {}\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(body.as_bytes()).await;
            let _ = stream.shutdown().await;
        }
    });
    (
        reqwest::Url::parse(&format!("http://{address}/")).expect("fake origin"),
        requests,
    )
}

/// A repository fixture with a GitHub remote. Repository variables a git hook
/// may have set are scrubbed, or `git -C <tempdir>` would address the
/// caller's checkout instead (the #845 pre-push lesson).
fn repository() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("repository");
    let run = |args: &[&str]| {
        let mut command = std::process::Command::new("git");
        command.args(args).current_dir(dir.path());
        for var in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_CEILING_DIRECTORIES",
        ] {
            command.env_remove(var);
        }
        let output = command.output().expect("run git fixture");
        assert!(output.status.success(), "git {args:?}: {output:?}");
    };
    run(&["init", "-q"]);
    run(&["checkout", "-q", "-b", "feature/x"]);
    run(&[
        "remote",
        "add",
        "origin",
        "https://github.com/acme/repo.git",
    ]);
    dir
}

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

#[tokio::test]
async fn a_real_session_binding_selects_the_github_credential_per_request() {
    if cmd::global().tokio().arg("-V").output().await.is_err() {
        eprintln!("tmux not available, skipping");
        return;
    }

    let repo = repository();
    // Three authenticated reads plus at most one Agent-fallback read.
    let (base, requests) = fake_github(4).await;
    let state = tempfile::tempdir().expect("binding state");
    let tmux = Arc::new(SessionManager::new().with_env_state_dir(state.path().to_path_buf()));
    let cwd = repo.path().to_string_lossy().into_owned();
    let profiles = [binding_profile()];

    let name_a = unique_session_name("env4080-a");
    let name_b = unique_session_name("env4080-b");
    let name_unbound = unique_session_name("env4080-unbound");
    let snapshot_a = binding_snapshot("session-token-a");
    let snapshot_b = binding_snapshot("session-token-b");
    tmux.create_session_with_binding(
        &name_a,
        80,
        24,
        &cwd,
        SessionBindingInput {
            revision: 1,
            profiles: &profiles,
            snapshots: std::slice::from_ref(&snapshot_a),
        },
    )
    .await
    .expect("create Session A with its binding");
    tmux.create_session_with_binding(
        &name_b,
        80,
        24,
        &cwd,
        SessionBindingInput {
            revision: 1,
            profiles: &profiles,
            snapshots: std::slice::from_ref(&snapshot_b),
        },
    )
    .await
    .expect("create Session B with its binding");
    tmux.create_session(&name_unbound, 80, 24, &cwd, &[])
        .await
        .expect("create the unbound Session");

    let extension = GithubAgentExtension::new(
        "git",
        Arc::new(RepoWorkdir(repo.path().to_path_buf())),
        Arc::new(GithubClient::new(base, None)),
        Arc::new(AgentSessionEnvironment::new(Arc::clone(&tmux))),
    );

    let first = extension
        .handle_command("github.issues", json!({ "session": name_a }))
        .await
        .expect("Session A read");
    assert_eq!(first["state"], "ok", "{first}");
    let second = extension
        .handle_command("github.issues", json!({ "session": name_b }))
        .await
        .expect("Session B read");
    assert_eq!(second["state"], "ok", "{second}");

    // A `github.env` edit re-applies the same profile at a new revision; the
    // next request must use the newly materialized value without an Agent
    // restart.
    let snapshot_a2 = binding_snapshot("session-token-a2");
    tmux.apply_session_binding(&name_a, 2, &profiles, std::slice::from_ref(&snapshot_a2))
        .await
        .expect("re-apply Session A's binding");
    let updated = extension
        .handle_command("github.issues", json!({ "session": name_a }))
        .await
        .expect("Session A read after update");
    assert_eq!(updated["state"], "ok", "{updated}");

    // The unbound Session inherits the Agent baseline. Its tmux environment
    // also contains that inherited value, which the resolver must not report
    // as an explicit Session override.
    let agent_token = agent_github_token();
    let unbound = extension
        .handle_command("github.issues", json!({ "session": name_unbound }))
        .await
        .expect("unbound Session read");
    match &agent_token {
        Some(_) => assert_eq!(unbound["state"], "ok", "{unbound}"),
        None => {
            assert_eq!(unbound["state"], "error", "{unbound}");
            assert_eq!(unbound["code"], "not_authenticated", "{unbound}");
        }
    }

    let requests = requests.lock().await.clone();
    let authorizations = authorization(&requests);
    assert_eq!(
        authorizations.first().map(String::as_str),
        Some("authorization: Bearer session-token-a"),
        "Session A's binding owns its first read: {requests:?}"
    );
    assert_eq!(
        authorizations.get(1).map(String::as_str),
        Some("authorization: Bearer session-token-b"),
        "Session B never shares Session A's identity: {requests:?}"
    );
    assert_eq!(
        authorizations.get(2).map(String::as_str),
        Some("authorization: Bearer session-token-a2"),
        "an applied binding revision reaches the next request: {requests:?}"
    );
    match &agent_token {
        Some(token) => assert_eq!(
            authorizations.get(3),
            Some(&format!("authorization: Bearer {token}")),
            "an unbound Session falls back to the Agent baseline: {requests:?}"
        ),
        None => assert_eq!(
            authorizations.len(),
            3,
            "without an Agent token the unbound Session makes no authenticated request: {requests:?}"
        ),
    }

    for name in [&name_a, &name_b, &name_unbound] {
        tmux.kill_session(name).await.expect("kill fixture Session");
    }
}
