//! End-to-end assertions against real temporary repositories (#750 SC1–SC3).
//!
//! The unit tests parse recorded output; these run git for real, which is the
//! only way to know the parser still matches what git emits. The recorded
//! fixtures were taken from a live `--porcelain=v2 --branch -z` run, but git
//! can change, and a parser that has drifted from reality is exactly the kind
//! of thing that reads as covered.
//!
//! ## Fixture setup is not the capability
//!
//! Committing is a mutating subcommand and `GitCmd` refuses it — deliberately,
//! because the capability is read-only. That leaves the tests needing a way to
//! *build* a repository, so setup shells out directly. That is confined to this
//! file and is fixture construction, not an invocation path the product can
//! reach.
//!
//! ## Why the helpers return `Result`
//!
//! `clippy.toml` allows `unwrap`/`expect` in tests, but that exemption applies
//! to `#[test]` functions — not to helpers they call. So the helpers here
//! return `Result` and each test unwraps at the call site, which is the shape
//! CLAUDE.md prescribes rather than an `#[allow]`.

use std::path::Path;
use std::process::Command;

use anyhow::{ensure, Context, Result};
use nession_git::cmd::GitCmd;
use nession_git::{diff, log, security, status};

/// Run a git command for fixture setup. See the module comment.
///
/// Scrubs the same repository-addressing variables `GitCmd` does. One test here
/// deliberately sets `GIT_DIR` to prove the capability ignores it, and cargo
/// runs tests in parallel threads — without this, that test's environment would
/// redirect a *fixture* command in another test and fail it at random. Fixture
/// setup and the capability must not be able to interfere.
fn git(dir: &Path, args: &[&str]) -> Result<()> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    for var in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CEILING_DIRECTORIES",
    ] {
        cmd.env_remove(var);
    }
    let out = cmd
        .output()
        .with_context(|| format!("fixture `git {args:?}` failed to start"))?;
    ensure!(
        out.status.success(),
        "fixture `git {args:?}` failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(())
}

/// A repository with one commit and `tracked.txt` committed.
fn repo() -> Result<tempfile::TempDir> {
    let dir = tempfile::tempdir().context("tempdir")?;
    git(dir.path(), &["init", "--quiet", "-b", "feature/capsule"])?;
    git(dir.path(), &["config", "user.email", "test@example.com"])?;
    git(dir.path(), &["config", "user.name", "Test"])?;
    std::fs::write(dir.path().join("tracked.txt"), "first\n").context("write tracked.txt")?;
    git(dir.path(), &["add", "tracked.txt"])?;
    git(dir.path(), &["commit", "--quiet", "-m", "initial"])?;
    Ok(dir)
}

fn cmd_for(dir: &tempfile::TempDir) -> GitCmd {
    GitCmd::new("git", dir.path())
}

#[test]
fn status_reports_branch_and_groups_changes() {
    let dir = repo().unwrap();
    std::fs::write(dir.path().join("tracked.txt"), "first\nsecond\n").unwrap();
    std::fs::write(dir.path().join("untracked.txt"), "new\n").unwrap();

    let cmd = cmd_for(&dir);
    let out = tokio::runtime::Runtime::new().unwrap().block_on(async {
        cmd.run(&["status", "--porcelain=v2", "--branch", "-z"], 64 * 1024)
            .await
    });
    let out = out.unwrap();

    let parsed = status::parse(&out.stdout).unwrap();
    assert_eq!(
        parsed.branch.as_deref(),
        Some("feature/capsule"),
        "branch must match the real repository"
    );
    assert!(!parsed.detached);
    assert_eq!(parsed.modified.len(), 1, "one tracked change");
    assert_eq!(parsed.modified[0].path, "tracked.txt");
    assert_eq!(parsed.untracked, vec!["untracked.txt"]);
    assert!(!parsed.is_clean());
}

#[test]
fn a_clean_repository_reports_clean() {
    let dir = repo().unwrap();
    let cmd = cmd_for(&dir);
    let out = tokio::runtime::Runtime::new().unwrap().block_on(async {
        cmd.run(&["status", "--porcelain=v2", "--branch", "-z"], 64 * 1024)
            .await
    });
    let out = out.unwrap();

    let parsed = status::parse(&out.stdout).unwrap();
    assert!(
        parsed.is_clean(),
        "a freshly committed tree is clean; got {parsed:?}"
    );
}

#[test]
fn diff_shows_the_change_to_a_tracked_file() {
    let dir = repo().unwrap();
    std::fs::write(dir.path().join("tracked.txt"), "first\nsecond\n").unwrap();

    let cmd = cmd_for(&dir);
    let result = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(async { diff::file_diff(&cmd, "tracked.txt").await })
        .unwrap();

    assert!(!result.binary);
    assert!(
        result.text.contains("+second"),
        "diff must show the added line, got: {}",
        result.text
    );
    assert!(!result.truncated);
    assert!(!result.is_empty());
}

#[test]
fn diff_of_an_untracked_file_is_empty_rather_than_wrong() {
    let dir = repo().unwrap();
    std::fs::write(dir.path().join("untracked.txt"), "new\n").unwrap();
    let cmd = cmd_for(&dir);

    // `git diff HEAD -- untracked.txt` exits 0 with no output for a path git
    // does not track, which would render as "this file has no changes" —
    // misleading. The view gives untracked entries no expander (#750 SC2), so
    // this documents what the command actually does for anyone who calls it
    // anyway.
    let result = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(async { diff::file_diff(&cmd, "untracked.txt").await })
        .unwrap();
    assert!(result.is_empty());
    assert!(!result.binary);
}

#[test]
fn a_path_escaping_the_repository_is_rejected_before_git_runs() {
    let dir = repo().unwrap();
    let cmd = cmd_for(&dir);
    let result = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(async { diff::file_diff(&cmd, "../../etc/passwd").await });
    assert!(result.is_err(), "an escaping path must not reach git");
}

#[test]
fn mutating_subcommands_are_refused() {
    let dir = repo().unwrap();
    let cmd = cmd_for(&dir);
    let result = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(async { cmd.run(&["commit", "-m", "nope"], 4096).await });

    assert!(
        result.is_err(),
        "the capability is read-only; `commit` must be refused"
    );
    let message = result.unwrap_err().to_string();
    assert!(
        message.contains("read-only"),
        "the refusal should say why, got: {message}"
    );
}

#[test]
fn a_non_repository_directory_is_distinguishable_from_a_missing_tool() {
    let dir = tempfile::tempdir().unwrap();
    let cmd = cmd_for(&dir);
    let runtime = tokio::runtime::Runtime::new().unwrap();

    assert!(
        runtime.block_on(async { cmd.available().await }),
        "git is installed here"
    );
    assert_eq!(
        runtime
            .block_on(async { cmd.resolve_root().await })
            .unwrap(),
        None,
        "a bare temp directory is not a repository"
    );
}

#[test]
fn the_root_names_the_work_tree_the_status_describes() {
    // The Signal's worktree identity and the Workspace header both read this,
    // and it comes from the same probe that decides "is this a repository" —
    // so a regression here is a regression in both.
    let dir = repo().unwrap();
    let cmd = cmd_for(&dir);
    let root = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(async { cmd.resolve_root().await })
        .unwrap()
        .expect("a real repository resolves to a root");

    // The tempdir may be a symlink on macOS (/var → /private/var), so compare
    // the tail the user would recognise rather than the whole path.
    assert_eq!(
        root.file_name(),
        dir.path().file_name(),
        "root {root:?} should name the fixture repository"
    );
}

#[test]
fn repository_discovery_ignores_an_inherited_git_dir() {
    // The environment is stripped from every child. If it were not, a stray
    // GIT_DIR would silently redirect every call to a different repository —
    // the failure this crate exists to prevent.
    let dir = repo().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    std::env::set_var("GIT_DIR", elsewhere.path());

    let cmd = cmd_for(&dir);
    let root = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(async { cmd.resolve_root().await })
        .unwrap();
    std::env::remove_var("GIT_DIR");

    assert!(
        root.is_some(),
        "GIT_DIR must not redirect the probe away from the working directory"
    );
}

#[test]
fn validate_then_resolve_agree_on_a_normal_path() {
    let root = Path::new("/repo");
    let relative = security::validate_repo_relative_path("src/lib.rs").unwrap();
    assert_eq!(
        security::resolve_within(root, &relative).unwrap(),
        Path::new("/repo/src/lib.rs")
    );
}

#[test]
fn history_reads_the_real_log() {
    // The unit tests parse strings this file's author wrote. This one runs git,
    // which is the only way to know `--format` still emits what the parser
    // expects — a format string that drifted would leave the parser reading
    // plausible-looking garbage and every synthetic test passing.
    let dir = repo().unwrap();
    std::fs::write(dir.path().join("tracked.txt"), "first\nsecond\n").unwrap();
    git(
        dir.path(),
        &[
            "commit",
            "--quiet",
            "-am",
            "second: a | subject — with punctuation",
        ],
    )
    .unwrap();

    let cmd = cmd_for(&dir);
    let history = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(async { log::history(&cmd, Some(10)).await })
        .unwrap();

    assert_eq!(history.commits.len(), 2, "the fixture has two commits");
    // Newest first, which is what `git log` gives and what a History view shows.
    assert_eq!(
        history.commits[0].subject, "second: a | subject — with punctuation",
        "a subject must survive whole — separators and all"
    );
    assert_eq!(history.commits[1].subject, "initial");
    assert!(!history.commits[0].author.is_empty());
    assert!(!history.commits[0].date.is_empty());
    assert!(history.commits[0]
        .hash
        .starts_with(&history.commits[0].short_hash));
    assert!(!history.truncated);
}

#[test]
fn history_honours_the_count_it_was_asked_for() {
    let dir = repo().unwrap();
    for n in 0..4 {
        std::fs::write(dir.path().join("tracked.txt"), format!("line {n}\n")).unwrap();
        git(
            dir.path(),
            &["commit", "--quiet", "-am", &format!("commit {n}")],
        )
        .unwrap();
    }

    let cmd = cmd_for(&dir);
    let history = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(async { log::history(&cmd, Some(2)).await })
        .unwrap();

    assert_eq!(history.limit, 2);
    assert_eq!(history.commits.len(), 2);
    // And it says which count it answered for, so a view can offer "more"
    // against something real rather than guessing.
    assert!(history.commits[0].subject.starts_with("commit 3"));
}
