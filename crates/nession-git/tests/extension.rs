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

/// Run git for a fixture with inherited repository variables scrubbed.
///
/// A test run under a git hook inherits `GIT_DIR` (and friends); without this,
/// `git -C <tempdir>` still addresses the caller's checkout — the isolation bug
/// the #845 pre-push run exposed.
fn git_output(root: &std::path::Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    let mut command = Command::new("git");
    command.arg("-C").arg(root).args(args);
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
    command.output()
}

/// A committed repository, built the same way `repository.rs` builds one.
fn repo() -> Result<tempfile::TempDir> {
    let dir = tempfile::tempdir()?;
    for args in [
        vec!["init", "--quiet", "-b", "main"],
        vec!["config", "user.email", "test@example.com"],
        vec!["config", "user.name", "Test"],
    ] {
        let out = git_output(dir.path(), &args)?;
        anyhow::ensure!(out.status.success(), "fixture `git {args:?}` failed");
    }
    std::fs::write(dir.path().join("a.txt"), "x\n")?;
    anyhow::ensure!(
        git_output(dir.path(), &["add", "a.txt"])?.status.success(),
        "fixture add failed"
    );
    anyhow::ensure!(
        git_output(dir.path(), &["commit", "--quiet", "-m", "init"])?
            .status
            .success(),
        "fixture commit failed"
    );
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
    // A missing required field is now a **decode failure at the boundary**, so
    // it is answered with the contract's own error state rather than propagated
    // as an `Err`. That is the improvement, not a relaxation: a propagated error
    // reached the registry, which answered `{"error": …, "available": false}` —
    // a shape this contract never defines and the Web client cannot branch on,
    // because it distinguishes the failure states by `state`.
    let dir = repo().unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));
    let result = run(&ext, "git.diff", json!({"session": "agent:s"})).unwrap();

    assert_eq!(result["state"], "error");
    assert!(
        result["message"].as_str().unwrap_or("").contains("path"),
        "the message should name the missing field, got {result}"
    );
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
    // The refusal still happens before git runs — that is `security`'s job and
    // unchanged. What changed is that it now travels back as the contract's
    // error state instead of as a propagated `Err` the registry would answer in
    // its own generic shape.
    let dir = repo().unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));
    let result = run(
        &ext,
        "git.diff",
        json!({"session": "agent:s", "path": "../../etc/passwd"}),
    )
    .unwrap();

    assert_eq!(result["state"], "error");
    assert!(
        result["message"]
            .as_str()
            .unwrap_or("")
            .contains("must not contain"),
        "the refusal should say which rule the path broke, got {result}"
    );
}

#[test]
fn preview_returns_the_worktree_text_for_an_untracked_file() {
    let dir = repo().unwrap();
    std::fs::write(dir.path().join("notes.txt"), "hello\n").unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));

    let result = run(
        &ext,
        "git.preview",
        json!({"session": "agent:s", "path": "notes.txt", "expected": "untracked"}),
    )
    .unwrap();

    assert_eq!(result["state"], "ok");
    assert_eq!(result["preview"]["path"], "notes.txt");
    assert_eq!(result["preview"]["state"], "ready");
    assert_eq!(result["preview"]["text"], "hello\n");
    assert_eq!(result["preview"]["binary"], false);
    assert_eq!(result["preview"]["truncated"], false);
}

#[test]
fn preview_returns_complete_media_bytes_for_an_untracked_image() {
    let dir = repo().unwrap();
    let bytes = b"\x89PNG\r\n\x1a\nmedia-bytes";
    std::fs::write(dir.path().join("logo.png"), bytes).unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));

    let result = run(
        &ext,
        "git.preview",
        json!({"session": "agent:s", "path": "logo.png", "expected": "untracked", "want": "media"}),
    )
    .unwrap();

    assert_eq!(result["state"], "ok");
    assert_eq!(result["preview"]["state"], "ready");
    assert_eq!(result["preview"]["text"], "");
    assert_eq!(result["preview"]["binary"], true);
    assert_eq!(result["preview"]["media"]["mime_type"], "image/png");
    assert_eq!(result["preview"]["media"]["complete"], true);
    assert!(!result["preview"]["media"]["content_base64"]
        .as_str()
        .unwrap_or("")
        .is_empty());
}

#[test]
fn a_text_preview_does_not_carry_media_fields() {
    let dir = repo().unwrap();
    std::fs::write(dir.path().join("notes.txt"), "hello\n").unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));

    let result = run(
        &ext,
        "git.preview",
        json!({"session": "agent:s", "path": "notes.txt", "expected": "untracked"}),
    )
    .unwrap();

    assert!(result["preview"].get("media").is_none(), "{result}");
}

#[test]
fn preview_refuses_a_path_that_is_not_the_selected_status_kind() {
    let dir = repo().unwrap();
    std::fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));

    let result = run(
        &ext,
        "git.preview",
        json!({"session": "agent:s", "path": "a.txt", "expected": "untracked"}),
    )
    .unwrap();

    assert_eq!(result["state"], "ok");
    assert_eq!(result["preview"]["state"], "changed");
    assert_eq!(result["preview"]["text"], "");
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
fn the_extension_declares_the_wire_types_the_registry_routes_on() {
    // The registry derives its routing table from these declarations, so this
    // list *is* the advertised set — there is no second one to disagree with.
    let ext = extension(None);
    assert_eq!(ext.name(), "git");

    let wires: Vec<String> = ext
        .descriptors()
        .unwrap()
        .into_iter()
        .flat_map(|d| d.contracts.into_iter().flat_map(|c| c.wire))
        .collect();

    for expected in [
        "git.status",
        "git.diff",
        "git.preview",
        "git.root",
        "git.log",
        "git.commit",
        "git.branches",
        "git.worktrees",
        "git.stage",
        "git.unstage",
        "git.create-commit",
    ] {
        assert!(
            wires.iter().any(|w| w == expected),
            "missing {expected} from {wires:?}"
        );
    }
}

#[test]
fn the_extension_declares_its_mutations_as_session_keyed() {
    // #845 SC-10 / #974: the scheduler must not learn this from the wire name.
    let policies = extension(None).execution_policies();
    for wire in ["git.stage", "git.unstage", "git.create-commit"] {
        assert!(
            policies.iter().any(|(declared, policy)| {
                *declared == wire
                    && *policy == nession_common::extension::ExtensionUnitPolicy::SessionMutation
            }),
            "{wire} must be declared a mutation, got {policies:?}"
        );
    }
    assert!(
        !policies.iter().any(|(wire, _)| *wire == "git.status"),
        "a read unit must keep the query default"
    );
}

/// The v2 status answer carries the snapshot the write units require.
fn status_v2(ext: &GitAgentExtension) -> Value {
    match run(
        ext,
        "git.status",
        json!({"session": "agent:s", "contract_version": 2}),
    ) {
        Ok(value) => value,
        Err(error) => panic!("git.status v2 failed: {error}"),
    }
}

#[test]
fn status_v1_is_unchanged_and_v2_adds_the_snapshot() {
    let dir = repo().unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));

    let v1 = run(&ext, "git.status", json!({"session": "agent:s"})).unwrap();
    assert_eq!(v1["state"], "ok");
    assert!(
        v1.get("snapshot").is_none(),
        "v1's shipped shape must not grow a field"
    );

    let v2 = status_v2(&ext);
    assert_eq!(v2["state"], "ok");
    assert!(
        v2["snapshot"]["token"]
            .as_str()
            .is_some_and(|t| !t.is_empty()),
        "v2 must carry an opaque snapshot, got {v2}"
    );
    assert!(v2["snapshot"]["head"].as_str().is_some());
}

#[test]
fn a_reviewed_stage_is_applied_and_returns_the_new_state() {
    let dir = repo().unwrap();
    std::fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));

    let reviewed = status_v2(&ext);
    let token = reviewed["snapshot"]["token"].as_str().unwrap();

    let staged = run(
        &ext,
        "git.stage",
        json!({"session": "agent:s", "path": "a.txt", "expectedSnapshot": token}),
    )
    .unwrap();

    assert_eq!(staged["state"], "ok", "got {staged}");
    assert_ne!(
        staged["snapshot"]["token"].as_str().unwrap(),
        token,
        "the post-state must be a new identity"
    );
    assert_eq!(staged["status"]["modified"][0]["path"], "a.txt");
    assert_eq!(staged["status"]["modified"][0]["staged"], true);
}

#[test]
fn a_stale_stage_is_refused_with_the_current_state() {
    let dir = repo().unwrap();
    std::fs::write(dir.path().join("a.txt"), "reviewed\n").unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));
    let reviewed = status_v2(&ext);
    let token = reviewed["snapshot"]["token"].as_str().unwrap().to_string();

    // Terminal-side edit after the review.
    std::fs::write(dir.path().join("a.txt"), "edited after review\n").unwrap();

    let response = run(
        &ext,
        "git.stage",
        json!({"session": "agent:s", "path": "a.txt", "expectedSnapshot": token}),
    )
    .unwrap();

    assert_eq!(response["state"], "repository_changed", "got {response}");
    assert!(response["snapshot"]["token"].as_str().is_some());
    assert_eq!(response["status"]["modified"][0]["staged"], false);
}

#[test]
fn unstage_keeps_the_worktree_bytes() {
    let dir = repo().unwrap();
    std::fs::write(dir.path().join("a.txt"), "kept\n").unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));
    let reviewed = status_v2(&ext);
    let token = reviewed["snapshot"]["token"].as_str().unwrap().to_string();

    let staged = run(
        &ext,
        "git.stage",
        json!({"session": "agent:s", "path": "a.txt", "expectedSnapshot": token}),
    )
    .unwrap();
    let staged_token = staged["snapshot"]["token"].as_str().unwrap().to_string();

    let unstaged = run(
        &ext,
        "git.unstage",
        json!({"session": "agent:s", "path": "a.txt", "expectedSnapshot": staged_token}),
    )
    .unwrap();

    assert_eq!(unstaged["state"], "ok", "got {unstaged}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "kept\n"
    );
    assert_eq!(unstaged["status"]["modified"][0]["staged"], false);
}

#[test]
fn a_commit_creates_one_commit_and_a_repeated_request_id_replays_it() {
    let dir = repo().unwrap();
    std::fs::write(dir.path().join("a.txt"), "committed\n").unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));
    let reviewed = status_v2(&ext);
    let token = reviewed["snapshot"]["token"].as_str().unwrap().to_string();
    let staged = run(
        &ext,
        "git.stage",
        json!({"session": "agent:s", "path": "a.txt", "expectedSnapshot": token}),
    )
    .unwrap();
    let staged_token = staged["snapshot"]["token"].as_str().unwrap().to_string();

    let request = json!({
        "session": "agent:s",
        "expectedSnapshot": staged_token,
        "message": "feat: change a",
        "requestId": "user-commit-1"
    });
    let first = run(&ext, "git.create-commit", request.clone()).unwrap();
    assert_eq!(first["state"], "ok", "got {first}");
    assert!(first["commit"]["oid"].as_str().is_some());
    assert!(
        first["commit"]["author"]
            .as_str()
            .unwrap_or("")
            .contains("Test"),
        "the answer states the effective author, got {first}"
    );

    // A lost response retried with the same identity must not create a second
    // commit; it replays the first answer.
    let retry = run(&ext, "git.create-commit", request).unwrap();
    assert_eq!(retry["state"], "ok");
    assert_eq!(retry["commit"]["oid"], first["commit"]["oid"]);

    let count = git_output(dir.path(), &["rev-list", "--count", "HEAD"]).unwrap();
    assert_eq!(String::from_utf8_lossy(&count.stdout).trim(), "2");
}

#[test]
fn a_commit_without_an_identity_says_so_specifically() {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.name", ""],
        vec!["config", "user.email", "nobody@example.com"],
    ] {
        let out = git_output(dir.path(), &args).unwrap();
        assert!(out.status.success());
    }
    std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));
    let reviewed = status_v2(&ext);
    let token = reviewed["snapshot"]["token"].as_str().unwrap().to_string();
    let staged = run(
        &ext,
        "git.stage",
        json!({"session": "agent:s", "path": "a.txt", "expectedSnapshot": token}),
    )
    .unwrap();
    let staged_token = staged["snapshot"]["token"].as_str().unwrap().to_string();

    let response = run(
        &ext,
        "git.create-commit",
        json!({
            "session": "agent:s",
            "expectedSnapshot": staged_token,
            "message": "feat: change",
            "requestId": "identity-test"
        }),
    )
    .unwrap();

    assert_eq!(response["state"], "missing_identity", "got {response}");
    assert!(response["message"].as_str().unwrap().contains("user.name"));
}

#[test]
fn the_read_only_commit_unit_still_answers_commit_detail() {
    // #845 SC-15: the new mutation has its own unit; `git.commit` keeps meaning
    // "read one commit's detail".
    let dir = repo().unwrap();
    let ext = extension(Some(dir.path().to_path_buf()));
    let log = run(&ext, "git.log", json!({"session": "agent:s"})).unwrap();
    let oid = log["history"]["commits"][0]["hash"]
        .as_str()
        .unwrap()
        .to_string();

    let detail = run(
        &ext,
        "git.commit",
        json!({"session": "agent:s", "oid": oid}),
    )
    .unwrap();
    assert_eq!(detail["state"], "ok", "got {detail}");
    assert_eq!(detail["commit"]["subject"], "init");
}
