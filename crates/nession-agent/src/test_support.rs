//! Test-only helpers shared by this crate's unit tests.
//!
//! Integration tests under `tests/` cannot see `#[cfg(test)]` items, so they
//! keep their own copy of this in `tests/integration/main.rs`. Keep the two in
//! step: both must produce names starting with [`TEST_SESSION_PREFIX`], and
//! both must kill the session on drop.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::tmux::cmd::TmuxCmd;
use crate::tmux::ops::TmuxDep;

/// Prefix shared by every tmux session the tests create, so the contents of a
/// run directory left behind by a crashed run are recognizable at a glance.
/// Since #582, `scripts/sweep-test-sessions.sh` reclaims whole owned run
/// directories by pattern (`nession-test-tmux.*`) rather than by session name.
pub(crate) const TEST_SESSION_PREFIX: &str = "nession-test-";

pub(crate) fn unique_session_name(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{TEST_SESSION_PREFIX}{prefix}-{nanos}")
}

/// Owns a generated session name and kills the tmux session on drop.
///
/// Tests clean up on their happy path only, so a panic between creating the
/// session and reaching that teardown used to leak it permanently. Drop runs
/// during unwind too, which closes that hole.
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
        let _ = crate::tmux::cmd::global()
            .std()
            .args(["kill-session", "-t", &self.name])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// Separator written after each recorded call, so a call's *boundaries* are
/// visible even when an argv entry contains a newline.
#[cfg(unix)]
pub(crate) const CALL_SEPARATOR: &str = "==call==";

/// A fake `tmux` binary, for substitution through [`TmuxDep::injected`].
///
/// It exists because the real binary cannot answer the questions #991 step 6
/// asks. Whether an operation ran at all, with which argv, and what the caller
/// does when it fails are all unobservable against real tmux: a call that
/// succeeds does so whatever grammar built it, and a required mutation only
/// fails where the session does not exist — which conflates "the failure
/// travelled to the caller" with "the failure was the one we meant".
///
/// The binary records the argv of every call, with the `-S <socket>` prefix
/// stripped exactly as real tmux receives it, and then runs `script`, whose
/// exit status and stderr are the call's. `script` is `/bin/sh`, and `$1` is
/// the subcommand.
///
/// Three files live in `dir`, which the caller owns (a `tempfile::TempDir`):
/// the binary (`tmux`, mode 0755), the recorder (`argv.log`), and the socket
/// the injected [`TmuxDep`] addresses (`tmux.sock`, never created — a fake
/// binds nothing).
#[cfg(unix)]
pub(crate) struct FakeTmux {
    bin: String,
    log: PathBuf,
    socket: PathBuf,
}

#[cfg(unix)]
impl FakeTmux {
    /// Write the fake into `dir`. Panics if it cannot be written or made
    /// executable — a fake that silently failed to install would take a test
    /// down a path that looks like the wiring under test.
    pub(crate) fn new(dir: &Path, script: &str) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("tmux");
        let log = dir.join("argv.log");
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\n\
                 if [ \"$1\" = \"-S\" ]; then shift 2; fi\n\
                 printf '%s\\n' \"$@\" >> \"{log}\"\n\
                 echo \"{sep}\" >> \"{log}\"\n\
                 {script}\n",
                log = log.display(),
                sep = CALL_SEPARATOR,
            ),
        )
        .expect("write the fake tmux");
        let mut perms = std::fs::metadata(&bin)
            .expect("fake tmux metadata")
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&bin, perms).expect("chmod the fake tmux");
        Self {
            bin: bin.to_string_lossy().into_owned(),
            log,
            socket: dir.join("tmux.sock"),
        }
    }

    /// The path of the fake, for a test that needs to name it.
    pub(crate) fn bin(&self) -> &str {
        &self.bin
    }

    /// The dependency these tests inject: this binary, on a socket no server
    /// ever bound. Both halves matter — the binary is what makes the call
    /// observable, and the socket is what makes "the injection did not take"
    /// fail loudly instead of quietly reaching the harness server.
    pub(crate) fn dep(&self) -> TmuxDep {
        TmuxDep::injected(TmuxCmd::new(self.bin.clone(), self.socket.clone()))
    }

    /// Every call recorded so far, each as the argv entries tmux received.
    pub(crate) fn calls(&self) -> Vec<Vec<String>> {
        let log = std::fs::read_to_string(&self.log).unwrap_or_default();
        log.split(CALL_SEPARATOR)
            // The separator is written *after* each call, so every block but
            // the first opens with the newline that ended the previous one.
            .map(|block| {
                block
                    .trim_matches('\n')
                    .lines()
                    .map(str::to_string)
                    .collect::<Vec<String>>()
            })
            .filter(|args| !args.is_empty())
            .collect()
    }

    /// Wait until at least `n` calls have been recorded, or `deadline` passes.
    ///
    /// A fake is a child process: a call it was asked to make may not have
    /// reached its recorder yet when the caller looks. Everywhere the caller
    /// *waited* for the child (a `status()` or a `output()`), the log is
    /// already complete and this returns immediately; it is for the calls the
    /// caller only *spawned*, where an immediate read would be a race whose
    /// outcome depends on machine load.
    pub(crate) async fn wait_for_calls(
        &self,
        n: usize,
        deadline: std::time::Duration,
    ) -> Vec<Vec<String>> {
        let until = std::time::Instant::now() + deadline;
        loop {
            let calls = self.calls();
            if calls.len() >= n || std::time::Instant::now() >= until {
                return calls;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
}
