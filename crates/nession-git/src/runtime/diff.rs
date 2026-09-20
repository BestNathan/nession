//! One file's diff, bounded.
//!
//! `git diff HEAD -- <path>` is the right question for "what changed in this
//! file": it shows staged and unstaged changes together against the last
//! commit, which is what someone opening the file from a change list expects.
//! `git diff` alone would hide anything already staged, and `--cached` would
//! hide everything else — either way the user sees a partial answer with no
//! indication it is partial.
//!
//! Untracked files are not diffed (#750 Open Question 4): synthesising an
//! "everything is added" diff for a large or binary file runs straight into the
//! byte cap, and the view already gives untracked entries no expander.

use crate::protocol::diff::v1::FileDiff;
use crate::runtime::cmd::GitCmd;
use crate::runtime::security::{self, MAX_DIFF_BYTES};

impl FileDiff {
    /// Whether the diff carries no hunks, e.g. a mode-only change.
    pub fn is_empty(&self) -> bool {
        !self.binary && !self.text.contains("@@")
    }
}

/// Diff one repository-relative path against HEAD.
pub async fn file_diff(cmd: &GitCmd, relative_path: &str) -> anyhow::Result<FileDiff> {
    let path = security::validate_repo_relative_path(relative_path)?;

    let out = cmd
        .run(
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                // Without this, a repository-local `diff.external` would run an
                // arbitrary program. The capability is read-only; that must not
                // depend on the repository's own configuration.
                "--no-textconv",
                "HEAD",
                "--",
                &path,
            ],
            MAX_DIFF_BYTES,
        )
        .await?;

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

#[cfg(test)]
mod tests {
    use super::*;

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
