//! The single place in this workspace that may spawn a `git` process.
//!
//! Every git invocation nession makes — `status`, `diff`, `rev-parse`,
//! `--version` — is built here, so every one of them carries an explicit
//! `-C <workdir>`, a scrubbed environment and a timeout. That is the whole
//! point, for the same reason `crates/nession-agent/src/tmux/cmd.rs` exists:
//! a call that inherits its repository from the environment is not addressing
//! the repository the user is looking at, and nothing at runtime says so.
//!
//! ## Environment is never trusted
//!
//! `git` resolves which repository it is operating on from the environment
//! before it looks at the working directory. An inherited `GIT_DIR` or
//! `GIT_WORK_TREE` — set by a hook, a `git rebase --exec`, or a shell inside a
//! session — silently redirects every call to a different repository. `-C`
//! decides the repository here, so those variables are stripped from every
//! child, exactly as `TMUX`/`TMUX_TMPDIR` are for tmux.
//!
//! ## Read-only is enforced, not assumed
//!
//! This module never runs a mutating subcommand (see `MUTATING_SUBCOMMANDS`,
//! which `run` refuses). `GIT_OPTIONAL_LOCKS=0` additionally stops git from
//! taking the index lock for commands that only refresh it — `git status` would
//! otherwise rewrite `.git/index` as a side effect of being asked to look.
//! `GIT_TERMINAL_PROMPT=0` keeps a credential prompt from hanging the agent
//! forever on a repository with a remote that wants auth.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::security::MAX_LINE_BYTES;

/// Environment variables that describe a repository we are not addressing.
/// Stripped from every child so behaviour never depends on inheritance.
const INHERITED_REPO_VARS: [&str; 6] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
];

/// Subcommands that write. `run` refuses them outright rather than relying on
/// review: this capability is read-only (#750 Non-Goals), and a read-only
/// viewer that can `commit` is a different product with a different risk
/// surface. Adding one here should be a deliberate, reviewable act.
const MUTATING_SUBCOMMANDS: [&str; 14] = [
    "add",
    "am",
    "apply",
    "checkout",
    "cherry-pick",
    "clean",
    "commit",
    "fetch",
    "merge",
    "pull",
    "push",
    "rebase",
    "reset",
    "restore",
];

/// Default wall-clock ceiling for one git invocation. `status` on a large
/// repository is normally fast; this is here so a pathological repository (or a
/// hung filesystem) returns an error instead of pinning an agent task forever.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

/// A git binary bound to the working directory every command will address.
#[derive(Debug, Clone)]
pub struct GitCmd {
    bin: String,
    workdir: PathBuf,
    timeout: Duration,
}

/// One completed git invocation.
#[derive(Debug, Clone)]
pub struct GitOutput {
    pub stdout: Vec<u8>,
    /// Bytes the process produced past the caller's cap and which were dropped.
    /// Zero means the output was complete.
    pub truncated_bytes: usize,
}

impl GitOutput {
    pub fn truncated(&self) -> bool {
        self.truncated_bytes > 0
    }

    pub fn stdout_string(&self) -> std::borrow::Cow<'_, str> {
        String::from_utf8_lossy(&self.stdout)
    }
}

impl GitCmd {
    /// Bind a git binary to a working directory. Does not touch the filesystem.
    pub fn new(bin: impl Into<String>, workdir: impl Into<PathBuf>) -> Self {
        Self {
            bin: bin.into(),
            workdir: workdir.into(),
            timeout: DEFAULT_TIMEOUT,
        }
    }

    pub fn workdir(&self) -> &Path {
        &self.workdir
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Build the child process. Private: [`run`](Self::run) is the only way to
    /// start one, so no caller can spawn a git process that skipped the env
    /// scrub, the `-C`, or the timeout.
    fn build(&self, args: &[&str]) -> Result<Command> {
        let subcommand = args.first().copied().unwrap_or_default();
        if MUTATING_SUBCOMMANDS.contains(&subcommand) {
            anyhow::bail!(
                "refusing mutating git subcommand `{subcommand}`: this capability is read-only"
            );
        }

        // The binary is a field because a host may point the agent at a
        // non-PATH git, not because the name is dynamic in any interesting
        // sense. Nothing here can hold a tmux path: tmux is spawned only by
        // `crates/nession-agent/src/tmux/cmd.rs`, which this crate deliberately
        // does not depend on (see `agent.rs` for why the agent injects a
        // resolver instead).
        // not-tmux: spawns git; the variable holds a git binary path.
        let mut cmd = Command::new(&self.bin);
        cmd.arg("--no-pager")
            // Reproducible, unquoted paths in `--porcelain` output. Without this
            // git escapes non-ASCII bytes as C-style octal, and every path we
            // parse back out is wrong for any file with a non-ASCII name.
            .arg("-c")
            .arg("core.quotepath=false")
            .arg("-C")
            .arg(&self.workdir)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        for var in INHERITED_REPO_VARS {
            cmd.env_remove(var);
        }
        cmd.env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_PAGER", "cat")
            .env("LC_ALL", "C");

        Ok(cmd)
    }

    /// Run git and capture at most `cap` bytes of stdout.
    ///
    /// Output past the cap is dropped, never buffered: `git diff` in a large
    /// repository can produce tens of megabytes, and the point of the cap is
    /// that we do not hold them. `truncated_bytes` reports what was dropped so
    /// the caller can say so — a half diff presented as a whole one is worse
    /// than an error (#750 C3).
    pub async fn run(&self, args: &[&str], cap: usize) -> Result<GitOutput> {
        let mut cmd = self.build(args)?;
        let display = format!("git {}", args.join(" "));

        let mut child = cmd
            .spawn()
            .with_context(|| format!("failed to spawn `{display}` (is git installed?)"))?;

        let mut stdout = child.stdout.take().context("child stdout was not piped")?;
        let mut stderr = child.stderr.take().context("child stderr was not piped")?;

        let read_stdout = async {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            let mut dropped = 0usize;
            loop {
                let n = stdout.read(&mut chunk).await?;
                if n == 0 {
                    break;
                }
                // `read` never reports more than the buffer holds, so `n` is in
                // range; `get` states that rather than asserting it. `split_at`
                // then divides the filled prefix from what the cap discards, so
                // the count of dropped bytes stays exact even though we never
                // hold them.
                let Some(bytes) = chunk.get(..n) else {
                    break;
                };
                let keep = cap.saturating_sub(buf.len()).min(n);
                let (head, tail) = bytes.split_at(keep);
                buf.extend_from_slice(head);
                dropped += tail.len();
            }
            Ok::<(Vec<u8>, usize), std::io::Error>((buf, dropped))
        };

        let read_stderr = async {
            let mut buf = Vec::new();
            // Diagnostics are for the error message only; bound them too.
            let _ = stderr.read_to_end(&mut buf).await;
            buf.truncate(4096);
            buf
        };

        let (collected, stderr_bytes) = tokio::time::timeout(self.timeout, async {
            let (out, err) = tokio::join!(read_stdout, read_stderr);
            let (stdout, dropped) = out?;
            Ok::<(GitOutput, Vec<u8>), std::io::Error>((
                GitOutput {
                    stdout,
                    truncated_bytes: dropped,
                },
                err,
            ))
        })
        .await
        .map_err(|_| anyhow::anyhow!("`{display}` timed out after {:?}", self.timeout))?
        .with_context(|| format!("failed reading `{display}` output"))?;

        let status = child
            .wait()
            .await
            .with_context(|| format!("`{display}` did not exit"))?;

        if !status.success() {
            let stderr_text = String::from_utf8_lossy(&stderr_bytes);
            anyhow::bail!("`{display}` failed ({}): {}", status, stderr_text.trim());
        }

        Ok(collected)
    }

    /// Convenience for commands whose output is a single trimmed line.
    pub async fn run_line(&self, args: &[&str]) -> Result<String> {
        let out = self.run(args, 64 * 1024).await?;
        Ok(out.stdout_string().trim().to_string())
    }

    /// Whether `git` runs at all. Distinguishes "no git installed" from "not a
    /// repository", which #750 requires be reported separately.
    pub async fn available(&self) -> bool {
        self.run_line(&["--version"]).await.is_ok()
    }

    /// Whether `workdir` is inside a work tree, and the root of it when it is.
    ///
    /// "Not a repository" is an **answer**, not a failure: outside a work tree
    /// git exits 128 with `fatal: not a git repository ...`. Reporting that as
    /// an error would collapse it into the same bucket as a permission problem
    /// or a missing git, and #750 SC4 requires the four states stay tellable
    /// apart. So that one message becomes `Ok(None)`; anything else propagates.
    ///
    /// The root comes back from the same probe rather than a second one. Every
    /// caller needs it — the Workspace header, and the Terminal Signal's
    /// worktree identity (`capability-emergence.md`) — and asking git twice for
    /// two facts one command already knows is a second chance to fail.
    /// `--show-toplevel` fails on exactly the directories `--is-inside-work-tree`
    /// answers `false` for, so it decides both questions.
    pub async fn resolve_root(&self) -> Result<Option<PathBuf>> {
        match self.run(&["rev-parse", "--show-toplevel"], 4096).await {
            Ok(out) => {
                let root = out.stdout_string().trim().to_string();
                if root.len() > MAX_LINE_BYTES {
                    anyhow::bail!("repository root path is implausibly long");
                }
                Ok(Some(PathBuf::from(root)))
            }
            Err(err) if is_not_a_repository(&err.to_string()) => Ok(None),
            Err(err) => Err(err),
        }
    }
}

/// The path components of a command line, for logging without shell quoting.
pub fn describe(args: &[impl AsRef<OsStr>]) -> String {
    let parts: Vec<String> = args
        .iter()
        .map(|a| a.as_ref().to_string_lossy().into_owned())
        .collect();
    format!("git {}", parts.join(" "))
}

/// Whether a git failure means "this is not a repository".
///
/// Git has no exit code for this — it uses 128 for every `fatal:` — so the
/// message is the only signal available. Matching text is fragile in general;
/// here the alternative is worse, because treating all of 128 as "not a
/// repository" would report a permission error as "no repository here" and send
/// the user looking in the wrong place. The phrase is git's own and stable
/// across the versions this targets.
fn is_not_a_repository(stderr: &str) -> bool {
    stderr.contains("not a git repository")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_gits_not_a_repository_message() {
        assert!(is_not_a_repository(
            "`git rev-parse --is-inside-work-tree` failed (exit status: 128): fatal: not a git repository (or any of the parent directories): .git"
        ));
    }

    #[test]
    fn does_not_swallow_other_fatal_errors() {
        // Permission problems and missing tools must stay errors, or #750 SC4's
        // four failure states collapse into one.
        assert!(!is_not_a_repository(
            "`git status` failed (exit status: 128): fatal: detected dubious ownership in repository"
        ));
        assert!(!is_not_a_repository(""));
    }
}
