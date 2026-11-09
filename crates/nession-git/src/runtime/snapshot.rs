//! The repository identity a write operation is reviewed against (#845).
//!
//! A mutation must be able to say "the state I am about to change is still the
//! state the user reviewed". The identity here is **not** a hash of every file:
//! it is HEAD, the index as Git itself reports it, the observed status, and the
//! filesystem metadata of every path that status mentions. That is enough to
//! detect a concurrent terminal-side `git add`, edit, checkout or commit, while
//! staying cheap enough to read with every Changes refresh.
//!
//! The token is opaque to the client. Equality is the whole contract: the
//! client sends one back, the Agent recomputes and compares.

use std::collections::BTreeSet;
use std::path::Path;

use anyhow::Context;
use sha2::{Digest, Sha256};

use crate::protocol::status::v1::RepoStatus;
use crate::protocol::GitSnapshotV1;
use crate::runtime::cmd::GitCmd;
use crate::runtime::security::{resolve_within, MAX_STATUS_BYTES};
use crate::runtime::status;

/// The state a status read or a mutation answers with, plus its identity.
#[derive(Debug, Clone)]
pub struct SnapshotState {
    pub snapshot: GitSnapshotV1,
    pub status: RepoStatus,
    pub truncated: bool,
    pub truncated_bytes: usize,
}

/// Read the repository's current state and identity.
///
/// The status invocation is the one the caller returns to the client, so the
/// snapshot and the listing cannot come from two different observations.
pub async fn read(cmd: &GitCmd, root: &Path) -> anyhow::Result<SnapshotState> {
    // `--untracked-files=all` rather than the UI's default: a staging list must
    // name individual files, and the snapshot needs each one's metadata rather
    // than a directory row whose own mtime does not change when a child is
    // edited.
    let out = cmd
        .run(
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ],
            MAX_STATUS_BYTES,
        )
        .await?;
    let parsed = status::parse(&out.stdout)?;
    let head = head_from_status(&out.stdout);

    let mut hasher = Sha256::new();
    feed(&mut hasher, "snapshot", b"nession-git/v1");
    feed(&mut hasher, "root", root.to_string_lossy().as_bytes());
    feed(
        &mut hasher,
        "head",
        head.as_deref().unwrap_or("unborn").as_bytes(),
    );
    feed(&mut hasher, "status", &out.stdout);

    // The index as content, not as a timestamp: `--raw` reports the blob id each
    // changed path has in the index, and unchanged paths are identified by HEAD.
    // `--no-renames` keeps the output a per-path identity rather than a
    // similarity guess.
    let index_raw = cmd
        .run(
            &["diff", "--cached", "--raw", "-z", "--no-renames"],
            MAX_STATUS_BYTES,
        )
        .await?;
    feed(&mut hasher, "index", &index_raw.stdout);
    feed(
        &mut hasher,
        "index-truncated",
        &index_raw.truncated_bytes.to_le_bytes(),
    );

    // The index file's own metadata is belt-and-braces beside the blob ids: it
    // also moves for flags `--raw` does not print (assume-unchanged,
    // intent-to-add), and it is one `stat`.
    let index_path = cmd
        .run_line(&["rev-parse", "--git-path", "index"])
        .await
        .context("resolving the index path")?;
    feed(
        &mut hasher,
        "index-file",
        stat_path(root, index_path.trim()).as_bytes(),
    );

    // Every path the status mentions, with its worktree metadata. `BTreeSet`
    // makes the stream order-independent of Git's output ordering.
    let mut paths: BTreeSet<&str> = BTreeSet::new();
    for file in &parsed.modified {
        paths.insert(file.path.as_str());
        if let Some(original) = file.original_path.as_deref() {
            paths.insert(original);
        }
    }
    for path in &parsed.untracked {
        paths.insert(path.as_str());
    }
    for path in &parsed.unmerged {
        paths.insert(path.as_str());
    }
    for path in paths {
        feed(&mut hasher, "path", path.as_bytes());
        feed(&mut hasher, "stat", stat_path(root, path).as_bytes());
    }

    let token = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    Ok(SnapshotState {
        snapshot: GitSnapshotV1 {
            token,
            head,
            root: root.to_string_lossy().to_string(),
        },
        status: parsed,
        truncated: out.truncated(),
        truncated_bytes: out.truncated_bytes,
    })
}

/// A length-delimited label/value pair, so two different field sequences cannot
/// produce the same digest stream.
fn feed(hasher: &mut Sha256, label: &str, value: &[u8]) {
    hasher.update(label.as_bytes());
    hasher.update([0u8]);
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
    hasher.update([0u8]);
}

/// `# branch.oid <id>` from porcelain v2, with `(initial)` meaning unborn.
fn head_from_status(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    text.split('\0').find_map(|record| {
        record.strip_prefix("# branch.oid ").and_then(|oid| {
            let oid = oid.trim();
            if oid == "(initial)" || oid.is_empty() {
                None
            } else {
                Some(oid.to_string())
            }
        })
    })
}

/// A stable spelling of one path's filesystem identity.
///
/// Missing paths get a sentinel rather than an error: a staged deletion is a
/// real state, and the snapshot must still be computable for it.
fn stat_path(root: &Path, path: &str) -> String {
    if path.is_empty() {
        return "empty".to_string();
    }
    let Ok(full) = resolve_within(root, path) else {
        return "unresolved".to_string();
    };
    match std::fs::symlink_metadata(&full) {
        Ok(metadata) => stat_signature(&metadata),
        Err(_) => "missing".to_string(),
    }
}

#[cfg(unix)]
fn stat_signature(metadata: &std::fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!(
        "{}:{}:{}:{}:{}:{}",
        metadata.mode(),
        metadata.size(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec(),
    )
}

#[cfg(not(unix))]
fn stat_signature(metadata: &std::fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    format!(
        "{}:{}:{modified}",
        metadata.len(),
        metadata.permissions().readonly()
    )
}

/// The HEAD commit a snapshot carries, if the repository has one.
pub fn head_of(state: &SnapshotState) -> Option<&str> {
    state.snapshot.head.as_deref()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn git_setup(root: &Path, args: &[&str]) {
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
        let output = command.output().expect("git must be installed");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git_setup(dir.path(), &["init", "-q"]);
        fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        git_setup(dir.path(), &["add", "a.txt"]);
        git_setup(
            dir.path(),
            &[
                "-c",
                "user.name=Nession Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-qm",
                "initial",
            ],
        );
        dir
    }

    async fn state(dir: &Path) -> SnapshotState {
        read(&GitCmd::new("git", dir), dir).await.unwrap()
    }

    #[tokio::test]
    async fn the_same_repository_state_produces_the_same_token() {
        let dir = repo();
        let first = state(dir.path()).await;
        let second = state(dir.path()).await;
        assert_eq!(first.snapshot.token, second.snapshot.token);
        assert_eq!(first.snapshot.head, second.snapshot.head);
        assert!(first.snapshot.head.is_some());
    }

    #[tokio::test]
    async fn a_worktree_edit_changes_the_token() {
        let dir = repo();
        let before = state(dir.path()).await;
        fs::write(dir.path().join("a.txt"), "two\n").unwrap();
        let after = state(dir.path()).await;
        assert_ne!(
            before.snapshot.token, after.snapshot.token,
            "an edit the user could review must invalidate the reviewed state"
        );
    }

    #[tokio::test]
    async fn an_index_change_with_identical_worktree_changes_the_token() {
        let dir = repo();
        fs::write(dir.path().join("a.txt"), "two\n").unwrap();
        let unstaged = state(dir.path()).await;
        git_setup(dir.path(), &["add", "a.txt"]);
        let staged = state(dir.path()).await;
        assert_ne!(
            unstaged.snapshot.token, staged.snapshot.token,
            "staged and unstaged are different reviewed states"
        );
    }

    #[tokio::test]
    async fn an_untracked_file_edit_changes_the_token() {
        let dir = repo();
        fs::write(dir.path().join("new.txt"), "one\n").unwrap();
        let before = state(dir.path()).await;
        fs::write(dir.path().join("new.txt"), "two\n").unwrap();
        let after = state(dir.path()).await;
        assert_ne!(before.snapshot.token, after.snapshot.token);
    }

    #[tokio::test]
    async fn an_unborn_repository_has_no_head_but_still_has_an_identity() {
        let dir = tempfile::tempdir().unwrap();
        git_setup(dir.path(), &["init", "-q"]);
        fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        let state = state(dir.path()).await;
        assert_eq!(state.snapshot.head, None);
        assert!(!state.snapshot.token.is_empty());
    }

    #[test]
    fn a_truncated_reading_is_not_silently_whole() {
        // The token cannot prove anything about bytes Git did not return; the
        // mutation path refuses on this flag rather than trusting the prefix.
        let state = SnapshotState {
            snapshot: GitSnapshotV1 {
                token: "t".to_string(),
                head: None,
                root: "/repo".to_string(),
            },
            status: status::parse(b"").unwrap(),
            truncated: true,
            truncated_bytes: 10,
        };
        assert!(state.truncated);
    }
}
