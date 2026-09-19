//! The extension's answers, including the failure states (#750 SC4).
//!
//! Everything here goes through the `AgentExtension` entry point rather than
//! calling the handlers, because the point is what a client actually receives.
//! The resolver is faked: this file is about the *state machine* — which of
//! "no session", "no directory", "no git", "not a repository" or "ok" a given
//! input produces — not about tmux.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use anyhow::{Context, Result};
use async_trait::async_trait;
use nession_common::extension::AgentExtension;
use nession_git::{GitAgentExtension, WorkdirResolver};
use serde_json::{json, Value};

/// Returns a fixed directory for any session, or `None` when the directory is
/// absent — standing in for "tmux does not know this session".
struct FixedResolver(Option<PathBuf>);

#[async_trait]
impl WorkdirResolver for FixedResolver {
    async fn resolve(&self, _session: &str) -> Option<PathBuf> {
        self.0.clone()
    }
}

fn extension(dir: Option<PathBuf>) -> GitAgentExtension {
    GitAgentExtension::new("git", Arc::new(FixedResolver(dir)))
}

fn run(ext: &GitAgentExtension, command: &str, payload: Value) -> Result<Value> {
    // `?`, not `unwrap`: this is a helper, and clippy's in-tests exemption
    // covers `#[test]` functions only.
    tokio::runtime::Runtime::new()
        .context("tokio runtime")?
        .block_on(async { ext.handle_command(command, payload).await })
}

/// A committed repository, built the same way `repository.rs` builds one.
fn repo() -> Result<tempfile::TempDir> {
    let dir = tempfile::tempdir()?;
    for args in [
        vec!["init", "--quiet", "-b", "main"],
        vec!["config", "user.email", "test@example.com"],
        vec!["config", "user.name", "Test"],
    ] {
        let mut cmd = Command::new("git");
        cmd.arg("-C")
            .arg(dir.path())
            .args(&args)
            .env_remove("GIT_DIR");
        let out = cmd.output()?;
        anyhow::ensure!(out.status.success(), "fixture `git {args:?}` failed");
    }
    std::fs::write(dir.path().join("a.txt"), "x\n")?;
    let mut add = Command::new("git");
    add.arg("-C")
        .arg(dir.path())
        .args(["add", "a.txt"])
        .env_remove("GIT_DIR");
    anyhow::ensure!(add.output()?.status.success(), "fixture add failed");
    let mut commit = Command::new("git");
    commit
        .arg("-C")
        .arg(dir.path())
        .args(["commit", "--quiet", "-m", "init"])
        .env_remove("GIT_DIR");
    anyhow::ensure!(commit.output()?.status.success(), "fixture commit failed");
    Ok(dir)
}

#[test]
fn a_missing_session_is_an_error_not_a_silent_ok() {
    let ext = extension(None);
    let result = run(&ext, "git.status", json!({})).unwrap();
    assert_eq!(result["state"], "error");
}

#[test]
fn an_unknown_session_directory_is_unavailable_with_a_reason() {
    // "tmux does not know this session" must not read the same as "this is not
    // a repository" — the user's next step is different.
    let ext = extension(None);
    let result = run(&ext, "git.status", json!({"session": "agent:gone"})).unwrap();
    assert_eq!(result["state"], "unavailable");
    assert_eq!(result["reason"], "session_workdir_unknown");
}

#[test]
fn a_directory_that_is_not_a_repository_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));
    let result = run(&ext, "git.status", json!({"session": "agent:s"})).unwrap();
    assert_eq!(result["state"], "not_a_repository");
    // Distinct from the unavailable case above; SC4 requires both be tellable
    // apart, and they carry different `state` values on purpose.
    assert!(result.get("reason").is_none());
}

#[test]
fn status_on_a_real_repository_returns_branch_and_changes() {
    let dir = repo().unwrap();
    std::fs::write(dir.path().join("a.txt"), "x\ny\n").unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));

    let result = run(&ext, "git.status", json!({"session": "agent:s"})).unwrap();
    assert_eq!(result["state"], "ok");
    assert_eq!(result["status"]["branch"], "main");
    assert_eq!(result["status"]["modified"][0]["path"], "a.txt");
    assert_eq!(result["truncated"], false);
    // The work tree the listing describes, so a Signal can name where it is
    // without a second request (`capability-emergence.md`).
    assert!(
        result["root"].as_str().is_some_and(|root| !root.is_empty()),
        "status carries the work tree root, got {:?}",
        result.get("root")
    );
}

#[test]
fn a_client_supplied_cwd_is_ignored_in_favour_of_the_resolved_one() {
    // C2: the repository is chosen agent-side. A payload carrying `cwd` must
    // not be able to redirect it — silently ignoring is the correct behaviour,
    // not an error, because accepting it is the vulnerability.
    let dir = repo().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));

    let result = run(
        &ext,
        "git.status",
        json!({"session": "agent:s", "cwd": elsewhere.path()}),
    )
    .unwrap();
    assert_eq!(
        result["state"], "ok",
        "the resolved repo is used, not the payload's"
    );
    assert_eq!(result["status"]["branch"], "main");
}

#[test]
fn diff_requires_a_path() {
    let dir = repo().unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));
    let result = run(&ext, "git.diff", json!({"session": "agent:s"}));
    assert!(result.is_err(), "a diff with no path is a caller error");
}

#[test]
fn diff_returns_the_change_for_a_tracked_file() {
    let dir = repo().unwrap();
    std::fs::write(dir.path().join("a.txt"), "x\ny\n").unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));

    let result = run(
        &ext,
        "git.diff",
        json!({"session": "agent:s", "path": "a.txt"}),
    )
    .unwrap();
    assert_eq!(result["state"], "ok");
    assert_eq!(result["diff"]["path"], "a.txt");
    assert!(result["diff"]["text"].as_str().unwrap().contains("+y"));
}

#[test]
fn diff_refuses_a_path_outside_the_repository() {
    let dir = repo().unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));
    let result = run(
        &ext,
        "git.diff",
        json!({"session": "agent:s", "path": "../../etc/passwd"}),
    );
    assert!(result.is_err(), "an escaping path must not be served");
}

#[test]
fn root_reports_the_repository_toplevel() {
    let dir = repo().unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));
    let result = run(&ext, "git.root", json!({"session": "agent:s"})).unwrap();
    assert_eq!(result["state"], "ok");
    // The tempdir may be a symlink on macOS (/var → /private/var), so compare
    // the tail rather than the whole path.
    let root = result["root"].as_str().unwrap();
    assert!(
        dir.path()
            .ends_with(std::path::Path::new(root).file_name().unwrap()),
        "root {root} should name the fixture repository"
    );
}

#[test]
fn an_unknown_command_is_refused() {
    let ext = extension(None);
    assert!(run(&ext, "git.nope", json!({})).is_err());
}

#[test]
fn the_extension_declares_the_message_types_the_server_routes_on() {
    let ext = extension(None);
    assert_eq!(ext.name(), "git");
    let types = ext.message_types();
    for expected in [
        "extension.git.status",
        "extension.git.diff",
        "extension.git.root",
    ] {
        assert!(types.contains(&expected), "missing {expected}");
    }
}
