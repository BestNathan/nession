//! Deterministic, non-executing Git snapshot materialization (#3022).
//!
//! Only Git plumbing runs. Repository code, hooks, package scripts and build
//! commands are never executed: the checkout is an input, not a program.
//! The clone is shallow, single-branch and tagless, while still leaving a
//! `.git` directory a developer tool can use (`status`, `add`, `commit`).

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

/// The exact Git identity a build is allowed to materialize.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitTarget {
    /// The validated `https://github.com/<owner>/<repo>` URL.
    pub repository_url: String,
    /// A branch name, or the full commit SHA named by `requested_sha`.
    pub reference: String,
    /// `Some(sha)` for a fixed-SHA request, `None` for a branch.
    pub requested_sha: Option<String>,
}

/// The resolved snapshot a build records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitSnapshot {
    pub commit_sha: String,
    pub branch: Option<String>,
}

/// A Git command runner. Tests substitute a recorder; production uses the
/// process runner.
pub trait GitCommandRunner: Send + Sync {
    /// Run one `git` invocation and return trimmed stdout.
    fn run(&self, args: &[String], cwd: Option<&Path>) -> Result<String>;
}

/// Runs the host `git` with a credential-free environment.
#[derive(Debug, Default, Clone)]
pub struct ProcessGitRunner {
    pub git_binary: Option<PathBuf>,
}

impl ProcessGitRunner {
    fn binary(&self) -> String {
        self.git_binary
            .as_ref()
            .map_or_else(|| "git".to_string(), |path| path.display().to_string())
    }
}

impl GitCommandRunner for ProcessGitRunner {
    fn run(&self, args: &[String], cwd: Option<&Path>) -> Result<String> {
        let mut command = Command::new(self.binary());
        command
            .args(args)
            // No system/global config, no prompt, no askpass, no hooks. The
            // clone is HTTPS-only upstream; these make a misconfigured host
            // fail instead of silently prompting or invoking a helper.
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_COMMON_DIR")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_ASKPASS", "/bin/false")
            .env("GIT_SSH_COMMAND", "/bin/false")
            .env("LC_ALL", "C")
            .stdin(std::process::Stdio::null());
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        let output = command
            .output()
            .with_context(|| format!("failed to execute git {}", args.join(" ")))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!(
                "git {} failed: {}",
                args.join(" "),
                stderr.trim().lines().next().unwrap_or("unknown error")
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
}

fn safety_args() -> Vec<String> {
    [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        "http.extraHeader=",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn arg_list(args: &[&str]) -> Vec<String> {
    safety_args()
        .into_iter()
        .chain(args.iter().map(|arg| (*arg).to_string()))
        .collect()
}

/// Materialize a validated Git target into `dest`.
///
/// A branch is resolved exactly once by the shallow clone; a fixed SHA is
/// fetched directly and a mismatch is an explicit failure. Either way the
/// resulting `.git` is usable for local developer actions and carries no
/// credential material.
pub fn materialize(
    target: &GitTarget,
    dest: &Path,
    runner: &dyn GitCommandRunner,
) -> Result<GitSnapshot> {
    if dest.exists() {
        anyhow::bail!("snapshot destination already exists: {}", dest.display());
    }
    if let Some(sha) = &target.requested_sha {
        let dest_string = dest.to_string_lossy().into_owned();
        let init = arg_list(&["init", dest_string.as_str()]);
        runner.run(&init, None).context("git init failed")?;
        let add = arg_list(&["remote", "add", "origin", target.repository_url.as_str()]);
        runner
            .run(&add, Some(dest))
            .context("git remote add failed")?;
        let fetch = arg_list(&["fetch", "--depth", "1", "--no-tags", "origin", sha.as_str()]);
        runner
            .run(&fetch, Some(dest))
            .with_context(|| format!("fixed commit {sha} is not fetchable"))?;
        let checkout = arg_list(&["checkout", "--detach", "FETCH_HEAD"]);
        runner
            .run(&checkout, Some(dest))
            .context("git checkout of the fixed commit failed")?;
    } else {
        let dest_string = dest.to_string_lossy().into_owned();
        let clone = arg_list(&[
            "clone",
            "--depth",
            "1",
            "--single-branch",
            "--no-tags",
            "--branch",
            target.reference.as_str(),
            target.repository_url.as_str(),
            dest_string.as_str(),
        ]);
        runner
            .run(&clone, None)
            .with_context(|| format!("branch {} is not fetchable", target.reference))?;
    }

    let head = runner.run(&arg_list(&["rev-parse", "HEAD"]), Some(dest))?;
    if head.len() != 40 || !head.bytes().all(|b| b.is_ascii_hexdigit()) {
        anyhow::bail!("git did not resolve a full commit SHA: {head:?}");
    }
    if let Some(expected) = &target.requested_sha {
        if &head != expected {
            anyhow::bail!("resolved commit {head} does not match requested commit {expected}");
        }
    }
    let status = runner.run(&arg_list(&["status", "--porcelain"]), Some(dest))?;
    if !status.is_empty() {
        anyhow::bail!("fresh snapshot is not clean: {status}");
    }
    let shallow = dest.join(".git").join("shallow");
    if !shallow.is_file() {
        anyhow::bail!("snapshot is not shallow: .git/shallow is missing");
    }
    let tags = runner.run(&arg_list(&["tag", "--list"]), Some(dest))?;
    if !tags.is_empty() {
        anyhow::bail!("snapshot unexpectedly contains tags: {tags}");
    }
    assert_git_snapshot_is_safe(dest)?;
    Ok(GitSnapshot {
        commit_sha: head,
        branch: target
            .requested_sha
            .is_none()
            .then(|| target.reference.clone()),
    })
}

/// Reject credential material and unsafe repository layout in `.git/config`.
///
/// The clone environment is credential-free, so a matching entry means the
/// host or a hostile repository planted one; the build refuses rather than
/// baking it into the image.
pub fn assert_git_snapshot_is_safe(dest: &Path) -> Result<()> {
    let config = dest.join(".git").join("config");
    let text = std::fs::read_to_string(&config)
        .with_context(|| format!("failed to read {}", config.display()))?;
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        for forbidden in ["credential", "extraheader", "insteadof", "askpass", "http."] {
            if lower.contains(forbidden) {
                anyhow::bail!("Git snapshot config contains forbidden credential material");
            }
        }
    }
    let origin = dest.join(".git");
    if !origin.is_dir() {
        anyhow::bail!("Git snapshot is missing its .git directory");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_COMMON_DIR")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    fn git_output(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_COMMON_DIR")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?}");
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn fixture_repo(root: &Path) -> (PathBuf, String, String) {
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        git(&source, &["init", "-q"]);
        fs::write(source.join("README.md"), "first\n").unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-q", "-m", "first"]);
        let first = git_output(&source, &["rev-parse", "HEAD"]);
        git(&source, &["branch", "-M", "main"]);
        fs::write(source.join("README.md"), "second\n").unwrap();
        git(&source, &["commit", "-q", "-am", "second"]);
        git(&source, &["tag", "v1"]);
        let second = git_output(&source, &["rev-parse", "HEAD"]);
        let bare = root.join("bare.git");
        git(
            root,
            &[
                "clone",
                "-q",
                "--bare",
                source.to_str().unwrap(),
                bare.to_str().unwrap(),
            ],
        );
        (bare, first, second)
    }

    #[test]
    fn a_branch_snapshot_is_shallow_tagless_clean_and_committable() {
        let root = tempfile::tempdir().unwrap();
        let (bare, _, second) = fixture_repo(root.path());
        let dest = root.path().join("snapshot");
        let target = GitTarget {
            repository_url: format!("file://{}", bare.display()),
            reference: "main".to_string(),
            requested_sha: None,
        };
        let snapshot = materialize(&target, &dest, &ProcessGitRunner::default()).unwrap();
        assert_eq!(snapshot.commit_sha, second);
        assert_eq!(snapshot.branch.as_deref(), Some("main"));
        assert!(dest.join(".git/shallow").is_file());
        assert!(git_output(&dest, &["tag", "--list"]).is_empty());
        // The snapshot remains a usable repository for developer actions.
        fs::write(dest.join("local.txt"), "local\n").unwrap();
        git(&dest, &["add", "local.txt"]);
        git(&dest, &["commit", "-q", "-m", "local change"]);
        assert!(git_output(&dest, &["status", "--porcelain"]).is_empty());
    }

    #[test]
    fn a_fixed_commit_is_fetched_exactly() {
        let root = tempfile::tempdir().unwrap();
        let (bare, first, second) = fixture_repo(root.path());
        let dest = root.path().join("snapshot");
        let target = GitTarget {
            repository_url: format!("file://{}", bare.display()),
            reference: first.clone(),
            requested_sha: Some(first.clone()),
        };
        let snapshot = materialize(&target, &dest, &ProcessGitRunner::default()).unwrap();
        assert_eq!(snapshot.commit_sha, first);
        assert_ne!(snapshot.commit_sha, second);
        assert!(snapshot.branch.is_none());
    }

    #[test]
    fn a_missing_fixed_commit_fails_explicitly() {
        let root = tempfile::tempdir().unwrap();
        let (bare, _, _) = fixture_repo(root.path());
        let dest = root.path().join("snapshot");
        let target = GitTarget {
            repository_url: format!("file://{}", bare.display()),
            reference: "a".repeat(40),
            requested_sha: Some("a".repeat(40)),
        };
        let error = materialize(&target, &dest, &ProcessGitRunner::default()).unwrap_err();
        assert!(format!("{error:#}").contains("not fetchable"), "{error:#}");
    }

    #[test]
    fn credential_material_in_git_config_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let (bare, _, _) = fixture_repo(root.path());
        let dest = root.path().join("snapshot");
        let target = GitTarget {
            repository_url: format!("file://{}", bare.display()),
            reference: "main".to_string(),
            requested_sha: None,
        };
        materialize(&target, &dest, &ProcessGitRunner::default()).unwrap();
        let config = dest.join(".git/config");
        let mut text = fs::read_to_string(&config).unwrap();
        text.push_str("\n[credential]\n\thelper = store\n");
        fs::write(&config, text).unwrap();
        assert!(assert_git_snapshot_is_safe(&dest).is_err());
    }
}
