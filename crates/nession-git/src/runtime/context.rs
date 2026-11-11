//! The repository's hosting-relevant identity, read through [`GitCmd`].
//!
//! `git.status` already answers the branch and its upstream, but a hosting
//! provider also needs the configured remotes: which remote a branch follows
//! decides *which* GitHub repository the Session is working with. This module
//! adds one read composed from the existing chokepoint, so a provider never
//! spawns git itself and a second `Command::new("git")` never appears.
//!
//! The shape is deliberately Git-generic. It names remotes, URLs, branch and
//! upstream, and nothing about a hosting provider; URL interpretation belongs
//! to the provider that needs it (`nession-github`).

use anyhow::Result;

use crate::runtime::cmd::GitCmd;
use crate::runtime::status;

/// A configured Git remote and both of its URL forms.
///
/// Fetch and push can differ (a fork workflow commonly does), so both are
/// retained. The provider decides which one describes the repository it may
/// read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRemote {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

/// The repository facts a hosting resolver needs, all read from one live
/// working directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryContext {
    /// Absolute work-tree root.
    pub root: String,
    /// Current branch, absent on a detached HEAD.
    pub branch: Option<String>,
    /// Configured upstream as `<remote>/<branch>`, absent when there is none.
    pub upstream: Option<String>,
    /// Configured remotes in `git remote -v` order.
    pub remotes: Vec<GitRemote>,
}

/// Read the repository context for `cmd`'s working directory.
///
/// `Ok(None)` is the "not a repository" answer, distinct from a failed read:
/// the caller can say so without confusing it with a missing git or a
/// permission error.
pub async fn read(cmd: &GitCmd) -> Result<Option<RepositoryContext>> {
    let Some(root) = cmd.resolve_root().await? else {
        return Ok(None);
    };

    // One status read supplies both branch and upstream. Porcelain v2 is the
    // stable machine form, and the parser already owns the detached/upstream
    // distinctions.
    let status_out = cmd
        .run(&["status", "--porcelain=v2", "--branch", "-z"], 64 * 1024)
        .await?;
    let status = status::parse(&status_out.stdout)?;

    let remotes_out = cmd.run(&["remote", "-v"], 64 * 1024).await?;
    let remotes = parse_remotes(&remotes_out.stdout_string());

    Ok(Some(RepositoryContext {
        root: root.to_string_lossy().to_string(),
        branch: status.branch,
        upstream: status.upstream,
        remotes,
    }))
}

/// Parse `git remote -v`.
///
/// Lines are `<name>\t<url> (fetch|push)`. Duplicate names are one remote with
/// both URL forms; a remote configured only for one direction keeps the other
/// empty rather than inventing a value.
pub fn parse_remotes(text: &str) -> Vec<GitRemote> {
    let mut remotes: Vec<GitRemote> = Vec::new();
    for line in text.lines() {
        let mut fields = line.splitn(2, '\t');
        let Some(name) = fields.next().filter(|name| !name.is_empty()) else {
            continue;
        };
        let Some(rest) = fields.next() else {
            continue;
        };
        let (url, kind) = if let Some(url) = rest.strip_suffix(" (fetch)") {
            (url, "fetch")
        } else if let Some(url) = rest.strip_suffix(" (push)") {
            (url, "push")
        } else {
            continue;
        };
        if url.is_empty() {
            continue;
        }
        match remotes.iter_mut().find(|remote| remote.name == name) {
            Some(remote) if kind == "fetch" => remote.fetch_url = url.to_string(),
            Some(remote) => remote.push_url = url.to_string(),
            None => remotes.push(GitRemote {
                name: name.to_string(),
                fetch_url: if kind == "fetch" {
                    url.to_string()
                } else {
                    String::new()
                },
                push_url: if kind == "push" {
                    url.to_string()
                } else {
                    String::new()
                },
            }),
        }
    }
    remotes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_fetch_and_push_urls_by_remote_name() {
        let remotes = parse_remotes(
            "origin\thttps://github.com/o/r.git (fetch)\n\
             origin\tgit@github.com:o/r.git (push)\n\
             upstream\thttps://github.com/u/r.git (fetch)\n",
        );
        assert_eq!(
            remotes,
            vec![
                GitRemote {
                    name: "origin".into(),
                    fetch_url: "https://github.com/o/r.git".into(),
                    push_url: "git@github.com:o/r.git".into(),
                },
                GitRemote {
                    name: "upstream".into(),
                    fetch_url: "https://github.com/u/r.git".into(),
                    push_url: String::new(),
                },
            ]
        );
    }

    #[test]
    fn ignores_malformed_lines_rather_than_inventing_a_url() {
        assert!(parse_remotes("origin\nnot-a-remote line\n\t(url) (fetch)\n").is_empty());
    }

    #[tokio::test]
    async fn reads_branch_upstream_and_remotes_from_a_real_repository() {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@example.com")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@example.com")
                .output()
                .unwrap()
        };
        assert!(git(&["init", "-q"]).status.success());
        assert!(git(&[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/repo.git"
        ])
        .status
        .success());
        assert!(git(&[
            "remote",
            "add",
            "upstream",
            "git@github.com:upstream/repo.git"
        ])
        .status
        .success());
        assert!(git(&["checkout", "-q", "-b", "feature/x"]).status.success());
        let context = read(&GitCmd::new("git", dir.path()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(context.branch.as_deref(), Some("feature/x"));
        assert_eq!(context.upstream, None);
        assert_eq!(context.remotes.len(), 2);
        assert_eq!(context.remotes[0].name, "origin");
        assert_eq!(
            context.remotes[0].fetch_url,
            "https://github.com/acme/repo.git"
        );
    }

    #[tokio::test]
    async fn outside_a_repository_is_an_answer_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(&GitCmd::new("git", dir.path())).await.unwrap(), None);
    }
}
