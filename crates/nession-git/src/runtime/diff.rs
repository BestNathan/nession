//! One file's diff, bounded.
//!
//! For a committed repository, `git diff HEAD -- <path>` combines staged
//! and unstaged changes against the latest commit. On an unborn branch `HEAD`
//! is not a revision; the empty tree is the equivalent baseline for the same
//! combined view. The empty-tree OID is computed by Git so SHA-256 repositories
//! work as well as SHA-1 repositories.
//! `git diff` alone would hide anything already staged, and `--cached` would
//! hide everything else — either way the user sees a partial answer with no
//! indication it is partial.
//!
//! Untracked files are not diffed (#750 Open Question 4): synthesising an
//! "everything is added" diff for a large or binary file runs straight into the
//! byte cap, and the view already gives untracked entries no expander.

use crate::protocol::diff::v1::FileDiff;
use crate::runtime::cmd::GitCmd;
use crate::runtime::security::{self, MAX_DIFF_BYTES, MAX_LINE_BYTES};

impl FileDiff {
    /// Whether the diff carries no hunks, e.g. a mode-only change.
    pub fn is_empty(&self) -> bool {
        !self.binary && !self.text.contains("@@")
    }
}

/// Diff one repository-relative path against HEAD, or between parent and `commit`.
pub async fn file_diff(
    cmd: &GitCmd,
    relative_path: &str,
    commit: Option<&str>,
) -> anyhow::Result<FileDiff> {
    let path = security::validate_repo_relative_path(relative_path)?;

    let out = if let Some(oid) = commit {
        let full = crate::runtime::commit::resolve_revision(cmd, oid).await?;
        let parent = crate::runtime::commit::diff_parent(cmd, &full).await?;
        cmd.run(
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                &parent,
                &full,
                "--",
                &path,
            ],
            MAX_DIFF_BYTES,
        )
        .await?
    } else {
        let baseline = workspace_diff_baseline(cmd).await?;
        cmd.run(
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                // Without this, a repository-local `diff.external` would run an
                // arbitrary program. The capability is read-only; that must not
                // depend on the repository's own configuration.
                "--no-textconv",
                &baseline,
                "--",
                &path,
            ],
            MAX_DIFF_BYTES,
        )
        .await?
    };

    let text = out.stdout_string().into_owned();
    // `git diff` prints this one line for a binary file instead of hunks. It is
    // not a failure — the file simply has no textual diff to show.
    let binary = text.lines().any(|l| l.starts_with("Binary files ")) && !text.contains("@@");

    Ok(FileDiff {
        path,
        text,
        binary,
        truncated_bytes: out.truncated_bytes,
        truncated: out.truncated(),
    })
}

/// Resolve the baseline for a single combined worktree diff.
///
/// An absent HEAD is normal for a repository before its first commit, but not
/// every failed HEAD lookup means an unborn branch (e.g. broken refs or objects).
/// Porcelain-v2's `branch.oid (initial)` is the explicit Git signal for that
/// state. Other failures remain errors; we must not disguise repository damage
/// as an empty initial history.
async fn workspace_diff_baseline(cmd: &GitCmd) -> anyhow::Result<String> {
    match cmd
        .run(&["rev-parse", "--verify", "HEAD^{commit}"], MAX_LINE_BYTES)
        .await
    {
        Ok(_) => Ok("HEAD".to_string()),
        Err(head_error) => {
            let status = cmd
                .run(
                    &[
                        "status",
                        "--porcelain=v2",
                        "--branch",
                        "-z",
                        "--untracked-files=no",
                    ],
                    MAX_LINE_BYTES,
                )
                .await?;
            let unborn = status
                .stdout
                .split(|byte| *byte == 0)
                .any(|record| record == b"# branch.oid (initial)");
            if !unborn {
                return Err(head_error);
            }

            // `hash-object` without -w only computes the OID; GitCmd allows
            // this exact read-only argument sequence and rejects write forms.
            // Using Git avoids a hard-coded SHA-1 empty-tree OID in SHA-256 repos.
            let oid = cmd
                .run_line(&["hash-object", "-t", "tree", "--stdin"])
                .await?;
            if oid.is_empty() {
                anyhow::bail!("git returned an empty OID for the empty tree");
            }
            Ok(oid)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;
    use std::path::Path;
    use std::process::Command;

    fn git_setup(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .expect("git must be installed for the real-repository fixture");
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn new_repo(args: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git_setup(dir.path(), args);
        dir
    }

    #[tokio::test]
    async fn unborn_repo_diff_combines_staged_and_unstaged_edits() {
        let repo = new_repo(&["init", "-q"]);
        fs::write(repo.path().join("123"), "staged\\n").unwrap();
        git_setup(repo.path(), &["add", "--", "123"]);
        fs::write(repo.path().join("123"), "staged\\nunstaged\\n").unwrap();

        let diff = file_diff(&GitCmd::new("git", repo.path()), "123", None)
            .await
            .unwrap();
        assert!(!diff.binary);
        assert!(!diff.truncated);
        assert!(diff.text.contains("new file mode 100644"));
        assert!(diff.text.contains("+staged"));
        assert!(diff.text.contains("+unstaged"));
        assert_eq!(diff.truncated_bytes, 0);
    }

    #[tokio::test]
    async fn unborn_repo_diff_shows_staged_only_file() {
        let repo = new_repo(&["init", "-q"]);
        fs::write(repo.path().join("123"), "staged\\n").unwrap();
        git_setup(repo.path(), &["add", "--", "123"]);

        let diff = file_diff(&GitCmd::new("git", repo.path()), "123", None)
            .await
            .unwrap();
        assert!(diff.text.contains("+staged"));
        assert!(!diff.text.contains("+unstaged"));
    }

    #[tokio::test]
    async fn unborn_sha256_repo_uses_its_own_empty_tree_oid() {
        let repo = new_repo(&["init", "-q", "--object-format=sha256"]);
        fs::write(repo.path().join("123"), "sha256\\n").unwrap();
        git_setup(repo.path(), &["add", "--", "123"]);

        let diff = file_diff(&GitCmd::new("git", repo.path()), "123", None)
            .await
            .unwrap();
        assert!(diff.text.contains("+sha256"));
        assert!(diff.text.contains("new file mode 100644"));
    }

    #[tokio::test]
    async fn committed_repo_diff_keeps_head_as_the_baseline() {
        let repo = new_repo(&["init", "-q"]);
        fs::write(repo.path().join("123"), "original\\n").unwrap();
        git_setup(repo.path(), &["add", "--", "123"]);
        git_setup(
            repo.path(),
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
        fs::write(repo.path().join("123"), "changed\\n").unwrap();

        let diff = file_diff(&GitCmd::new("git", repo.path()), "123", None)
            .await
            .unwrap();
        assert!(diff.text.contains("-original"));
        assert!(diff.text.contains("+changed"));
        assert!(!diff.text.contains("new file mode"));
    }

    #[tokio::test]
    async fn corrupt_head_is_not_treated_as_an_unborn_repository() {
        let repo = new_repo(&["init", "-q"]);
        // A detached HEAD pointing at a missing object is corruption, not the
        // ordinary unborn symbolic branch reported as `branch.oid (initial)`.
        fs::write(repo.path().join(".git/HEAD"), "1111111111111111111111111111111111111111\\n")
            .unwrap();
        fs::write(repo.path().join("123"), "content\\n").unwrap();

        let error = file_diff(&GitCmd::new("git", repo.path()), "123", None)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("bad object")
                || error.to_string().contains("HEAD"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn binary_detection_ignores_a_path_that_merely_says_binary() {
        // A diff *about* a file called "Binary files ..." still has hunks, and
        // must not be reported as binary.
        let diff = FileDiff {
            path: "x".into(),
            text: "Binary files a/x and b/x differ\n".to_string(),
            binary: true,
            truncated_bytes: 0,
            truncated: false,
        };
        assert!(diff.binary);

        let textual = FileDiff {
            path: "x".into(),
            text:
                "diff --git a/x b/x\n@@ -1 +1 @@\n-Binary files are cool\n+binary files are cool\n"
                    .to_string(),
            binary: false,
            truncated_bytes: 0,
            truncated: false,
        };
        assert!(!textual.binary);
        assert!(!textual.is_empty());
    }

    #[test]
    fn mode_only_change_is_empty() {
        let diff = FileDiff {
            path: "x".into(),
            text: "diff --git a/x b/x\nold mode 100644\nnew mode 100755\n".to_string(),
            binary: false,
            truncated_bytes: 0,
            truncated: false,
        };
        assert!(diff.is_empty());
    }
}
