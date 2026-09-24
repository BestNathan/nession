// Single harness for all nession-agent integration tests.

mod connection;
mod control_mode;
mod full_chain; // ← e2e_test.rs renamed (spec: Rust has no E2E layer)
mod server;
mod sync;
mod tmux;

// ── Shared helpers ───────────────────────────────────────────────────────────

// unique_session_name: defined 5× across the 6 files, 4 of them byte-identical.
// Extract to crate root. control_mode's copy differs (extra ctrl- segment) and
// stays module-private.
use rand::Rng;

/// Prefix shared by every tmux session these tests create, so the contents of
/// a run directory left behind by a crashed run are recognizable at a glance.
/// Since #582, `scripts/sweep-test-sessions.sh` reclaims whole owned run
/// directories by pattern (`nession-test-tmux.*`) rather than by session name.
pub(crate) const TEST_SESSION_PREFIX: &str = "nession-test-";

pub(crate) fn unique_session_name(prefix: &str) -> String {
    let suffix: u32 = rand::thread_rng().gen();
    format!("{TEST_SESSION_PREFIX}{prefix}-{suffix}")
}

/// A fake `tmux` binary, for substitution through
/// [`TmuxDep::injected`](nession_agent::tmux::ops::TmuxDep::injected).
///
/// The unit-test copy of this is `crate::test_support::FakeTmux`, which
/// integration tests cannot see (see the note on [`TestSession`]). Keep the two
/// in step: both record the argv of every call with the `-S <socket>` prefix
/// stripped, both run `script` with `/bin/sh`, and both leave the recorded log
/// in the caller's temp dir.
///
/// It is here rather than in one test file because #991 step 6 is about a seam
/// that has to be reachable *from outside the crate*: a test that reached it
/// only through `#[cfg(test)]` items would pass while the seam stayed
/// unavailable to every other consumer.
#[cfg(unix)]
pub(crate) struct FakeTmux {
    bin: String,
    dir: std::path::PathBuf,
    socket: std::path::PathBuf,
}

#[cfg(unix)]
impl FakeTmux {
    /// Write the fake into `dir`.
    ///
    /// `io::Result` rather than panicking here: this file's helpers are not
    /// themselves test code, so `allow-expect-in-tests` does not cover them —
    /// the caller (a `#[test]`) is where a failure is allowed to be fatal.
    pub(crate) fn new(dir: &std::path::Path, script: &str) -> std::io::Result<Self> {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("tmux");
        std::fs::write(
            &bin,
            // One file per call, claimed with an O_EXCL create, so two
            // processes recording at once (a spawned tmux client and the parent
            // making awaited calls) cannot interleave. The mechanism, the
            // rejected alternatives and the measurements are documented on the
            // unit-test copy in `crates/nession-agent/src/test_support.rs`;
            // this body must stay in step with it.
            format!(
                "#!/bin/sh\n\
                 if [ \"$1\" = \"-S\" ]; then shift 2; fi\n\
                 set -C\n\
                 n=0\n\
                 while ! : 2>/dev/null > \"{dir}/{prefix}$n\"; do\n\
                 n=$((n + 1))\n\
                 if [ \"$n\" -gt 9999 ]; then break; fi\n\
                 done\n\
                 set +C\n\
                 printf '%s\\n' \"$@\" >> \"{dir}/{prefix}$n\"\n\
                 echo \"{sep}\" >> \"{dir}/{prefix}$n\"\n\
                 {script}\n",
                dir = dir.display(),
                prefix = CALL_FILE_PREFIX,
                sep = CALL_SEPARATOR,
            ),
        )?;
        let mut perms = std::fs::metadata(&bin)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&bin, perms)?;
        Ok(Self {
            bin: bin.to_string_lossy().into_owned(),
            dir: dir.to_path_buf(),
            socket: dir.join("tmux.sock"),
        })
    }

    /// The tmux dependency to inject: this binary, on a socket no server has
    /// bound — so a call that failed to reach the fake cannot quietly succeed
    /// against a real one.
    pub(crate) fn dep(&self) -> nession_agent::tmux::ops::TmuxDep {
        nession_agent::tmux::ops::TmuxDep::injected(nession_agent::tmux::cmd::TmuxCmd::new(
            self.bin.clone(),
            self.socket.clone(),
        ))
    }

    /// Every call recorded so far, each as the argv entries tmux received.
    pub(crate) fn calls(&self) -> Vec<Vec<String>> {
        let mut calls = Vec::new();
        for n in 0.. {
            let path = self.dir.join(format!("{CALL_FILE_PREFIX}{n}"));
            let text = match std::fs::read_to_string(&path) {
                Ok(text) => text,
                // Indices are claimed in order, so the first free one means
                // there is nothing after it either.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                // Present but not readable — mid-write. Not a call yet.
                Err(_) => continue,
            };
            // The file exists from the moment its index is claimed, so a call
            // still being written has no terminator.
            let Some(body) = text.trim_end_matches('\n').strip_suffix(CALL_SEPARATOR) else {
                continue;
            };
            let entries: Vec<String> = body
                .trim_matches('\n')
                .lines()
                .map(str::to_string)
                .collect();
            if !entries.is_empty() {
                calls.push(entries);
            }
        }
        calls
    }
}

/// Prefix of the one-file-per-call records [`FakeTmux`] writes into its
/// directory.
#[cfg(unix)]
pub(crate) const CALL_FILE_PREFIX: &str = "call.";

/// Terminator [`FakeTmux`] writes after the argv of each recorded call.
#[cfg(unix)]
pub(crate) const CALL_SEPARATOR: &str = "==call==";

/// What tmux holds for `name` in `session` — the value half of the one
/// `NAME=VALUE` line it prints, or `None` when tmux does not hold it.
///
/// This is how a test asks tmux what it actually holds, rather than asking
/// nession whether it thinks it succeeded — the distinction #980 turned on.
///
/// It goes through `TmuxOps::show_environment`, the one authoritative
/// implementation of `show-environment`'s grammar, exactly as the mutation
/// under test goes through `TmuxOps::set_environment`: the roundtrip is then a
/// read-back through the *operation*, not through a second hand-written copy of
/// the command that a grammar change could miss. `TmuxOps` builds every command
/// on `tmux::cmd::global()`, so this also addresses the socket the run was given
/// (`scripts/check-tmux-socket.sh` enforces that form).
///
/// A tmux that could not be asked at all collapses into `None` here, which is
/// what this helper has always reported; `Result` is the operation's contract,
/// and a test that needs the distinction asserts it directly on the operation.
pub(crate) async fn tmux_show_environment(session: &str, name: &str) -> Option<String> {
    nession_agent::tmux::ops::TmuxOps::global()
        .show_environment(session, name)
        .await
        .ok()
        .flatten()
}

/// Owns a generated session name and kills the tmux session on drop.
///
/// The tests' own `kill_session` calls only run on the happy path, so a panic
/// between creation and teardown used to leak the session permanently. Drop
/// runs during unwind too, which closes that hole.
pub(crate) struct TestSession {
    name: String,
}

impl TestSession {
    pub(crate) fn new(prefix: &str) -> Self {
        Self {
            name: unique_session_name(prefix),
        }
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }
}

impl Drop for TestSession {
    fn drop(&mut self) {
        // Synchronous by necessity: Drop cannot await. A non-zero status just
        // means the test already cleaned up, so the result is ignored.
        //
        // Goes through tmux::cmd like every other tmux call in the workspace, so
        // this kill lands on nession's socket. A bare `tmux kill-session` here
        // would target the developer's real tmux server, where a name collision
        // would kill *their* session.
        let _ = nession_agent::tmux::cmd::global()
            .std()
            .args(["kill-session", "-t", &self.name])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}
