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
//! The read path ([`GitCmd::run`]) never runs a mutating subcommand (see
//! `MUTATING_SUBCOMMANDS`, which it refuses). `GIT_OPTIONAL_LOCKS=0`
//! additionally stops git from taking the index lock for commands that only
//! refresh it — `git status` would otherwise rewrite `.git/index` as a side
//! effect of being asked to look. `GIT_TERMINAL_PROMPT=0` keeps a credential
//! prompt from hanging the agent forever on a repository with a remote that
//! wants auth.
//!
//! ## The write boundary is narrow, typed and still one place
//!
//! #845 opened exactly three writes: stage, unstage and create-commit. Each has
//! a typed method below that constructs its own argv from already-validated
//! input; none accepts a command or arbitrary arguments. The read guard is not
//! weakened — it is a different [`Access`] on the same constructor, reachable
//! only from those methods. That is the difference between "the denylist was
//! deleted" and "the allowed forms are enumerated".

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::time::Instant;

use crate::runtime::security::MAX_LINE_BYTES;

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

/// Subcommands that write. The read path refuses them outright rather than
/// relying on review. Three typed mutation forms are the deliberate exception
/// (#845); they construct their argv inside this module and never pass through
/// the read path's checks.
const MUTATING_SUBCOMMANDS: [&str; 15] = [
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
    // `rm` mutates the index; the typed unstage form is the only caller that
    // needs it, and it does not travel through the read path.
    "rm",
];

/// Subcommands that have a read form and a write form under the **same name**.
///
/// `MUTATING_SUBCOMMANDS` matches the first argument, which is the whole story
/// for `commit` or `push` — but `git worktree add` and `git worktree list` begin
/// with the same word, so a list of subcommand names cannot see the difference.
/// For these, the second argument decides, and only the forms named here are
/// reads: anything else fails closed rather than open, because the read set is
/// one word and closed and a denylist would have to anticipate every future
/// write.
///
/// `branch` is deliberately absent, and that is the better half of the same
/// decision: the branch listing is asked for through `for-each-ref`, which has
/// no write form at all. Choosing the command that cannot write beats teaching
/// this module to tell two spellings apart — and `for-each-ref` is what git
/// documents for exactly this.
const READ_ONLY_SUBCOMMAND_FORMS: [(&str, &[&str]); 1] = [("worktree", &["list"])];

/// Flags that turn an otherwise read-only subcommand into a write.
///
/// `hash-object` computes an object id from stdin, and `-w` additionally stores
/// the object. This capability needs the first and must never perform the
/// second, so the write spelling fails closed here rather than depending on a
/// caller remembering not to pass it.
const HASH_OBJECT_WRITE_FLAGS: [&str; 2] = ["-w", "--write"];

/// Default wall-clock ceiling for one git invocation. `status` on a large
/// repository is normally fast; this is here so a pathological repository (or a
/// hung filesystem) returns an error instead of pinning an agent task forever.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

/// Bounded allowance to kill and reap a child after the wall-clock deadline.
///
/// The deadline covers spawn, stdin, both output streams and process exit. If
/// it expires, the manager sends a kill and waits at most this long for the
/// direct child to disappear; it never waits on an unbounded cleanup path.
pub const CLEANUP_ALLOWANCE: Duration = Duration::from_secs(2);

/// Output ceiling for the narrowly typed mutation forms. They print status
/// lines, not diffs, so anything larger is reported as truncation rather than
/// held.
const MAX_MUTATION_BYTES: usize = 64 * 1024;

/// Output ceiling for a commit. Hooks are allowed to be chatty; the answer is
/// diagnostics, never repository content.
const MAX_COMMIT_BYTES: usize = 256 * 1024;

/// Whether a child is allowed to write.
///
/// The read-only guard in [`GitCmd::build_with`] is the module's whole reason
/// for existing, so a write is not "the same spawn with a flag": it is a
/// separate path reachable only from the typed methods below, each of which
/// constructs its own argv. No caller can hand this module an arbitrary
/// mutating command (#845 §8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Access {
    ReadOnly,
    Mutation,
}

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
    /// The read-only constructor, used by the guard tests below.
    ///
    /// Production dispatch goes through [`GitCmd::run_with`]; this exists so a
    /// test can prove the read path refuses a mutating argv without spawning a
    /// process.
    #[cfg(test)]
    fn build(&self, args: &[&str]) -> Result<Command> {
        self.build_with(args, Access::ReadOnly)
    }

    /// The one constructor, parameterised by what the child is allowed to do.
    ///
    /// Every check below is read-only policy: the mutation path is not a
    /// relaxation of it, because nothing outside this module can call
    /// `build_with(_, Access::Mutation)` and the typed methods construct their
    /// own argv.
    fn build_with(&self, args: &[&str], access: Access) -> Result<Command> {
        let subcommand = args.first().copied().unwrap_or_default();
        if access == Access::ReadOnly {
            if MUTATING_SUBCOMMANDS.contains(&subcommand) {
                anyhow::bail!(
                    "refusing mutating git subcommand `{subcommand}`: this path is read-only"
                );
            }

            // The other half of the same guarantee. A subcommand whose name is
            // also a write is only a read in the listed forms; `worktree add`
            // reaches here with `subcommand == "worktree"`, which the check
            // above cannot see.
            if let Some((_, forms)) = READ_ONLY_SUBCOMMAND_FORMS
                .iter()
                .find(|(name, _)| *name == subcommand)
            {
                let form = args.get(1).copied().unwrap_or_default();
                if !forms.contains(&form) {
                    anyhow::bail!(
                        "refusing `git {subcommand} {form}`: `git {subcommand}` is read-only only as {}",
                        forms.join(" or ")
                    );
                }
            }

            if subcommand == "hash-object"
                && args.iter().any(|arg| HASH_OBJECT_WRITE_FLAGS.contains(arg))
            {
                anyhow::bail!(
                    "refusing `hash-object` with a write flag: this capability only computes object ids"
                );
            }
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
            .env("GIT_PAGER", "cat")
            .env("LC_ALL", "C");
        if access == Access::ReadOnly {
            cmd.env("GIT_OPTIONAL_LOCKS", "0");
        } else {
            // Writes participate in Git's real locking. Suppressing optional
            // locks is a read-side convenience and would be the wrong promise
            // for a child that is about to take the index lock on purpose.
            cmd.env_remove("GIT_OPTIONAL_LOCKS");
        }

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
        self.run_with(args, cap, Access::ReadOnly, None).await
    }

    /// The one spawn path, shared by reads and the typed mutation forms.
    async fn run_with(
        &self,
        args: &[&str],
        cap: usize,
        access: Access,
        stdin: Option<&[u8]>,
    ) -> Result<GitOutput> {
        let mut cmd = self.build_with(args, access)?;
        if stdin.is_some() {
            cmd.stdin(Stdio::piped());
        }
        // Cancellation drops the future without running the timeout branch.
        // `kill_on_drop` is the mechanism that still terminates and reaps the
        // direct child in that path; the timeout branch below additionally
        // proves the reap within a bounded allowance.
        cmd.kill_on_drop(true);
        let display = format!("git {}", args.join(" "));
        let deadline = Instant::now() + self.timeout;

        let mut child = cmd
            .spawn()
            .with_context(|| format!("failed to spawn `{display}` (is git installed?)"))?;

        // One wall-clock deadline covers stdin, both output streams and process
        // exit. Writing stdin and draining stdout/stderr happen concurrently
        // with the wait, so neither a stalled pipe nor a child that never exits
        // can outlive the configured bound.
        let outcome = tokio::time::timeout_at(deadline, async {
            // Commit messages travel on stdin, never as an argument, so a
            // message that begins with `-` or contains anything argv-hostile is
            // data.
            if let Some(bytes) = stdin {
                let mut sink = child.stdin.take().context("child stdin was not piped")?;
                if let Err(error) = sink.write_all(bytes).await {
                    drop(sink);
                    terminate_and_reap(&mut child).await;
                    return Err(error).with_context(|| format!("writing stdin to `{display}`"));
                }
                drop(sink);
            }

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
                    // `read` never reports more than the buffer holds, so `n` is
                    // in range; `get` states that rather than asserting it.
                    // `split_at` then divides the filled prefix from what the
                    // cap discards, so the count of dropped bytes stays exact
                    // even though we never hold them.
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

            let (out, stderr_bytes) = tokio::join!(read_stdout, read_stderr);
            let (stdout, dropped) = match out {
                Ok(output) => output,
                Err(error) => {
                    // A failed read must not leave the child running after the
                    // caller receives the error.
                    terminate_and_reap(&mut child).await;
                    return Err(error)
                        .with_context(|| format!("failed reading `{display}` output"));
                }
            };
            let status = child
                .wait()
                .await
                .with_context(|| format!("`{display}` did not exit"))?;

            if !status.success() {
                let stderr_text = String::from_utf8_lossy(&stderr_bytes);
                anyhow::bail!("`{display}` failed ({}): {}", status, stderr_text.trim());
            }

            Ok::<GitOutput, anyhow::Error>(GitOutput {
                stdout,
                truncated_bytes: dropped,
            })
        })
        .await;

        match outcome {
            Ok(result) => result,
            Err(_) => {
                // The future is dropped here, so its borrow of `child` ends.
                // Kill and reap the direct child within the bounded allowance;
                // never touch an unrelated process or a grandchild by guess.
                terminate_and_reap(&mut child).await;
                Err(anyhow::anyhow!(
                    "`{display}` timed out after {:?}",
                    self.timeout
                ))
            }
        }
    }

    /// Convenience for commands whose output is a single trimmed line.
    pub async fn run_line(&self, args: &[&str]) -> Result<String> {
        let out = self.run(args, 64 * 1024).await?;
        Ok(out.stdout_string().trim().to_string())
    }

    // ── Narrowly typed mutations (#845 §8) ───────────────────────────────
    //
    // The allowed argv is constructed here, from already-validated paths. No
    // method takes a raw command or arbitrary arguments, so opening the write
    // boundary did not turn this module into an argv passthrough.

    /// Stage one repository-relative path, including its deletion.
    pub async fn stage_path(&self, path: &str) -> Result<GitOutput> {
        self.run_with(
            &["add", "-A", "--", path],
            MAX_MUTATION_BYTES,
            Access::Mutation,
            None,
        )
        .await
    }

    /// Restore the index entry of each path without touching worktree bytes.
    ///
    /// With a HEAD, `reset` restores the entries from it. An unborn branch has
    /// nothing to restore from, so the index entry is removed instead — the
    /// same index mutation, expressed for the one state that has no baseline.
    pub async fn unstage_paths(&self, paths: &[&str], has_head: bool) -> Result<GitOutput> {
        let mut args: Vec<&str> = if has_head {
            vec!["reset", "-q", "HEAD", "--"]
        } else {
            vec!["rm", "--cached", "-q", "--"]
        };
        args.extend_from_slice(paths);
        self.run_with(&args, MAX_MUTATION_BYTES, Access::Mutation, None)
            .await
    }

    /// Create one commit from the current index, honouring hooks and signing.
    ///
    /// `-F -` instead of `-m`: the message is data on stdin, and Git's own
    /// cleanup rules still apply. `--no-verify` is deliberately absent.
    pub async fn commit_staged(&self, message: &str) -> Result<GitOutput> {
        self.run_with(
            &["commit", "-F", "-"],
            MAX_COMMIT_BYTES,
            Access::Mutation,
            Some(message.as_bytes()),
        )
        .await
    }

    /// The author identity Git would use for a commit.
    ///
    /// `git var` answers with the effective value (configuration, environment
    /// and fallback included) rather than this crate guessing from `user.name`.
    pub async fn author_identity(&self) -> Result<String> {
        let raw = self.run_line(&["var", "GIT_AUTHOR_IDENT"]).await?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            anyhow::bail!("git returned an empty author identity");
        }
        Ok(trim_ident(trimmed))
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

/// Terminate and reap the direct git child within a bounded allowance.
///
/// Only the child this module spawned is signalled. Git hooks are separate
/// processes; this deliberately does not guess a process group or kill
/// something it does not own (#3462).
async fn terminate_and_reap(child: &mut tokio::process::Child) {
    let _ = child.start_kill();
    let _ = tokio::time::timeout(CLEANUP_ALLOWANCE, child.wait()).await;
}

/// The path components of a command line, for logging without shell quoting.
pub fn describe(args: &[impl AsRef<OsStr>]) -> String {
    let parts: Vec<String> = args
        .iter()
        .map(|a| a.as_ref().to_string_lossy().into_owned())
        .collect();
    format!("git {}", parts.join(" "))
}

/// `A U Thor <a@example.com> 1794122676 +0800` -> `A U Thor <a@example.com>`.
///
/// The trailing timestamp and timezone are Git's, not the identity the user
/// needs confirmed before committing.
fn trim_ident(raw: &str) -> String {
    match raw.rfind('>') {
        Some(end) => raw.get(..=end).unwrap_or(raw).to_string(),
        None => raw.to_string(),
    }
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

    fn guard(args: &[&str]) -> Result<Command> {
        GitCmd::new("git", "/repo").build(args)
    }

    #[test]
    fn refuses_a_mutating_subcommand_by_name() {
        for args in [
            vec!["commit", "-m", "x"],
            vec!["push"],
            vec!["checkout", "main"],
        ] {
            assert!(guard(&args).is_err(), "expected {args:?} to be refused");
        }
    }

    #[test]
    fn allows_the_read_form_of_a_subcommand_that_can_also_write() {
        // `git worktree list` and `git worktree add` share their first argument,
        // so the name is not enough — this is the check that tells them apart.
        assert!(guard(&["worktree", "list", "--porcelain"]).is_ok());
    }

    #[test]
    fn refuses_the_write_forms_of_that_subcommand() {
        for args in [
            vec!["worktree", "add", "/tmp/wt"],
            vec!["worktree", "remove", "/tmp/wt"],
            vec!["worktree", "prune"],
            vec!["worktree", "lock", "/tmp/wt"],
            // A bare `git worktree` lists, but nothing here asks for that
            // spelling, so an argument this module cannot vouch for fails closed.
            vec!["worktree"],
            vec!["worktree", "--help"],
        ] {
            assert!(guard(&args).is_err(), "expected {args:?} to be refused");
        }
    }

    #[test]
    fn allows_hash_object_to_compute_but_refuses_its_write_form() {
        assert!(guard(&["hash-object", "-t", "tree", "--stdin"]).is_ok());
        for args in [
            vec!["hash-object", "-w", "-t", "tree", "--stdin"],
            vec!["hash-object", "--write", "-t", "tree", "--stdin"],
        ] {
            assert!(guard(&args).is_err(), "expected {args:?} to be refused");
        }
    }

    #[test]
    fn the_read_path_still_refuses_the_mutation_subcommands() {
        // Opening the typed write forms must not have opened the read path:
        // `stage_path` constructs its argv inside this module, but a caller
        // reaching `build` with the same words is still refused.
        for args in [
            vec!["add", "-A", "--", "a.txt"],
            vec!["reset", "-q", "HEAD", "--", "a.txt"],
            vec!["rm", "--cached", "a.txt"],
        ] {
            assert!(guard(&args).is_err(), "expected {args:?} to be refused");
        }
    }

    #[test]
    fn the_identity_reports_the_person_not_the_timestamp() {
        assert_eq!(
            trim_ident("A U Thor <a@example.com> 1794122676 +0800"),
            "A U Thor <a@example.com>"
        );
        assert_eq!(trim_ident("odd"), "odd");
    }

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

    // ── wall-clock child lifecycle (#3462) ───────────────────────────────

    #[cfg(target_os = "linux")]
    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, body).expect("write fake git");
        let mut permissions = std::fs::metadata(&path)
            .expect("stat fake git")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).expect("chmod fake git");
        path
    }

    #[cfg(target_os = "linux")]
    fn process_running(pid: u32) -> bool {
        Path::new(&format!("/proc/{pid}")).exists()
    }

    #[cfg(target_os = "linux")]
    async fn wait_for_pid(path: &Path) -> u32 {
        for _ in 0..200 {
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(pid) = text.trim().parse() {
                    return pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("fake git never wrote {}", path.display());
    }

    #[cfg(target_os = "linux")]
    async fn wait_for_exit(pid: u32) -> bool {
        for _ in 0..300 {
            if !process_running(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }

    /// A controlled child that closes both pipes but stays alive must not keep
    /// the call pending past the deadline plus the bounded cleanup allowance.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_silent_child_that_never_exits_is_killed_at_the_deadline() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pidfile = dir.path().join("pid");
        let fake = script(
            dir.path(),
            "git-silent",
            &format!(
                "#!/bin/sh\necho $$ > '{}'\nexec sleep 60 >/dev/null 2>&1\n",
                pidfile.display()
            ),
        );
        let cmd = GitCmd::new(fake.to_string_lossy(), dir.path())
            .with_timeout(Duration::from_millis(500));

        let started = std::time::Instant::now();
        let error = cmd.run(&["status"], 1024).await.unwrap_err();
        let elapsed = started.elapsed();
        assert!(
            error.to_string().contains("timed out"),
            "unexpected error: {error:#}"
        );
        assert!(
            elapsed < Duration::from_millis(500) + CLEANUP_ALLOWANCE + Duration::from_secs(2),
            "deadline plus cleanup allowance was exceeded: {elapsed:?}"
        );

        let pid = wait_for_pid(&pidfile).await;
        assert!(
            wait_for_exit(pid).await,
            "the timed-out direct child {pid} was not reaped"
        );
    }

    /// A child that keeps stdout open without producing bytes is terminated and
    /// reaped; the timeout is an error, not a successful read.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_stalled_output_child_is_killed_and_reaped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pidfile = dir.path().join("pid");
        let fake = script(
            dir.path(),
            "git-stalled",
            &format!(
                "#!/bin/sh\necho $$ > '{}'\nprintf 'partial'\nexec sleep 60\n",
                pidfile.display()
            ),
        );
        let cmd = GitCmd::new(fake.to_string_lossy(), dir.path())
            .with_timeout(Duration::from_millis(500));

        let error = cmd.run(&["status"], 1024).await.unwrap_err();
        assert!(
            error.to_string().contains("timed out"),
            "unexpected error: {error:#}"
        );
        let pid = wait_for_pid(&pidfile).await;
        assert!(
            wait_for_exit(pid).await,
            "the stalled direct child {pid} was not reaped"
        );
    }

    /// Dropping the caller future must not leave the direct git child alive.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn cancellation_kills_the_git_child() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pidfile = dir.path().join("pid");
        let fake = script(
            dir.path(),
            "git-cancelled",
            &format!(
                "#!/bin/sh\necho $$ > '{}'\nexec sleep 60 >/dev/null 2>&1\n",
                pidfile.display()
            ),
        );
        let cmd =
            GitCmd::new(fake.to_string_lossy(), dir.path()).with_timeout(Duration::from_secs(30));

        let cancelled =
            tokio::time::timeout(Duration::from_millis(300), cmd.run(&["status"], 1024)).await;
        assert!(cancelled.is_err(), "the future should still be running");
        let pid = wait_for_pid(&pidfile).await;
        assert!(
            wait_for_exit(pid).await,
            "cancellation left the direct git child {pid} alive"
        );
    }

    /// A child that finishes inside the deadline still returns its exact
    /// stdout, and a non-zero exit keeps its status and diagnostics.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_normal_child_keeps_its_exact_output_and_failure() {
        let dir = tempfile::tempdir().expect("tempdir");
        let good = script(
            dir.path(),
            "git-good",
            "#!/bin/sh\nprintf 'exact-output\\n'\nprintf 'diagnostic\\n' >&2\nexit 0\n",
        );
        let output = GitCmd::new(good.to_string_lossy(), dir.path())
            .with_timeout(Duration::from_secs(5))
            .run(&["status"], 1024)
            .await
            .expect("a fast child must succeed");
        assert_eq!(output.stdout_string(), "exact-output\n");
        assert!(!output.truncated());

        let bad = script(
            dir.path(),
            "git-bad",
            "#!/bin/sh\nprintf 'ignored\\n'\nprintf 'fatal diagnostic\\n' >&2\nexit 7\n",
        );
        let error = GitCmd::new(bad.to_string_lossy(), dir.path())
            .with_timeout(Duration::from_secs(5))
            .run(&["status"], 1024)
            .await
            .unwrap_err();
        let text = format!("{error:#}");
        assert!(text.contains("failed (exit status: 7)"), "{text}");
        assert!(text.contains("fatal diagnostic"), "{text}");
    }
}
