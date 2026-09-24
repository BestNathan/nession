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

/// Prefix of the one-file-per-call records the fake writes into its directory.
#[cfg(unix)]
pub(crate) const CALL_FILE_PREFIX: &str = "call.";

/// Terminator written after the argv of each recorded call.
///
/// It is what tells a reader the call was recorded *whole*: the file exists
/// from the moment its index is claimed, so a call still being written has no
/// terminator yet and is not reported.
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
/// The binary (`tmux`, mode 0755), the socket the injected [`TmuxDep`]
/// addresses (`tmux.sock`, never created — a fake binds nothing), and one
/// record file per call (`call.0`, `call.1`, …) live in `dir`, which the caller
/// owns (a `tempfile::TempDir`).
///
/// ## The recorder is safe for concurrent writers
///
/// More than one process records at once: the PTY backend *spawns* a tmux
/// client (the attach) while the parent keeps making awaited calls. **Each call
/// gets its own file**, so there is nothing to interleave — the writer claims
/// an index by creating `call.N`, and writes that file alone. The claim is
/// `: > call.N` under `set -C`: an `O_EXCL` create (atomic on every filesystem
/// this runs on) performed by the shell itself, so it spawns no process.
/// Indices are claimed in order and densely, so `calls()` reads `call.0` upward
/// and stops at the first index nobody holds. The claim loop is bounded, so a
/// directory that cannot be written fails the call loudly instead of spinning.
///
/// A single shared log was measured and rejected, twice. `O_APPEND` orders each
/// `write(2)`, but a call is not one `write` — the shell's write boundary is
/// the **newline**. Measured on `/bin/sh` (bash 3.2 in POSIX mode, macOS) with
/// eight concurrent processes: a newline-separated record spliced at line
/// granularity in every one of 15 rounds, and so did a single `printf` whose
/// one argument held the newlines (15 of 15); redirecting stdout once for both
/// writes changed nothing (9 of 10). Removing the newlines — a record built as
/// `arg<US>arg<US>…<RS>` and appended with one `printf '%s'` — did make the
/// record one `write` (0 of 15 rounds), but only up to the shell's output
/// buffer (measured: the split starts between 544 and 2080 bytes), and it needs
/// an in-band separator: a separator is a byte the *data* may also contain, and
/// the coverage run's own `__CARGO_LLVM_COV_RUSTC_WRAPPER_RUSTFLAGS` carries
/// 0x1f bytes — one of them was read as an entry boundary the first time that
/// format ran under `cargo llvm-cov`. A lock removes all of it too, at the cost
/// of two process spawns per call — and that latency turned `pty.rs`'s
/// `a_refused_detach_changes_neither_close_nor_drop`, which races the pid its
/// spawned child writes, from 30 passes in 30 runs into 23 failures in 30.
/// Per-call files cost neither a separator nor a spawn.
#[cfg(unix)]
pub(crate) struct FakeTmux {
    bin: String,
    dir: PathBuf,
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
        std::fs::write(
            &bin,
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
        )
        .expect("write the fake tmux");
        let mut perms = std::fs::metadata(&bin)
            .expect("fake tmux metadata")
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&bin, perms).expect("chmod the fake tmux");
        Self {
            bin: bin.to_string_lossy().into_owned(),
            dir: dir.to_path_buf(),
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
        let mut calls = Vec::new();
        for n in 0.. {
            let path = self.dir.join(format!("{CALL_FILE_PREFIX}{n}"));
            let text = match std::fs::read_to_string(&path) {
                Ok(text) => text,
                // Indices are claimed in order, so the first free one means
                // there is nothing after it either.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                // Present but not readable — mid-write, or a read that landed
                // between two bytes of a multi-byte character. Not a call yet.
                Err(_) => continue,
            };
            // The file exists from the moment its index is claimed, so a call
            // still being written has no terminator: report it only once the
            // whole argv is on disk.
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

/// The recorder is written by more than one process, so one call has to be
/// recorded in one piece.
///
/// Eight processes record at once — the shape the PTY backend creates when it
/// *spawns* a tmux client while the parent keeps making awaited calls — and
/// every call `calls()` reads back has to be exactly one call's argv, with all
/// eighty present.
///
/// Reddens on: dropping the per-call isolation, i.e. writing the records into
/// one file instead of `call.N` (measured: 3 runs of 3 failed, and so did every
/// run of the shared-log recorder this replaced), and on widening what `calls()`
/// accepts so that a merged record becomes a valid answer. It is not a rare
/// flake in either direction, which is the point.
#[cfg(unix)]
#[test]
fn concurrent_writers_do_not_splice_the_recorded_calls() {
    use std::process::{Command, Stdio};

    let dir = tempfile::tempdir().unwrap();
    let fake = FakeTmux::new(dir.path(), "exit 0");
    let bin = fake.bin().to_string();
    let socket = dir.path().join("tmux.sock");

    let mut handles = Vec::new();
    for writer in 0..8u32 {
        let bin = bin.clone();
        let socket = socket.clone();
        handles.push(std::thread::spawn(move || {
            for _ in 0..10 {
                // not-tmux: this runs the FakeTmux fixture, not tmux itself
                let mut cmd = Command::new(&bin);
                cmd.arg("-S").arg(&socket);
                if writer % 3 == 0 {
                    cmd.args(["attach", "-t", "sess"]);
                } else {
                    cmd.args(["set-option", "-t", "sess", "status", "off"]);
                }
                cmd.stdout(Stdio::null()).stderr(Stdio::null());
                cmd.status().unwrap();
            }
        }));
    }
    for handle in handles {
        handle.join().unwrap();
    }

    let calls = fake.calls();
    let expected = ["attach -t sess", "set-option -t sess status off"];
    for call in &calls {
        let joined = call.join(" ");
        assert!(
            expected.contains(&joined.as_str()),
            "a recorded block is not exactly one call: {calls:?}"
        );
    }
    assert_eq!(
        calls.len(),
        80,
        "all 80 calls are recorded, each as its own block: {calls:?}"
    );
}

/// A call is reported once it is recorded *whole*, and in the order its index
/// was claimed.
///
/// Both halves are what the recorder's isolation buys a reader: the index is
/// claimed before the argv is written, so a file without its terminator is a
/// call still in flight — reporting it would hand the caller half an argv, and
/// `wait_for_calls` would count it — and the indices are dense, so reading
/// upward cannot skip a call.
#[cfg(unix)]
#[test]
fn a_call_is_reported_only_after_its_terminator() {
    let dir = tempfile::tempdir().unwrap();
    let fake = FakeTmux::new(dir.path(), "exit 0");
    let path = dir.path().join(format!("{CALL_FILE_PREFIX}0"));

    std::fs::write(&path, "set-option\n-t\nsess\n").unwrap();
    assert_eq!(
        fake.calls(),
        Vec::<Vec<String>>::new(),
        "a call whose argv is still being written is not a call yet"
    );

    std::fs::write(&path, "set-option\n-t\nsess\n==call==\n").unwrap();
    std::fs::write(
        dir.path().join(format!("{CALL_FILE_PREFIX}1")),
        "attach\n-t\nsess\n==call==\n",
    )
    .unwrap();

    let expected: Vec<Vec<String>> = [["set-option", "-t", "sess"], ["attach", "-t", "sess"]]
        .map(|call| call.iter().map(ToString::to_string).collect())
        .to_vec();
    assert_eq!(
        fake.calls(),
        expected,
        "each call reads back as the argv tmux received, in index order"
    );
}
