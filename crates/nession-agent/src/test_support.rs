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

/// Prefix of the one-directory-per-call records the fake writes.
///
/// Each call's index is claimed by creating `call.N`, and its argv is written
/// inside as `call.N/argv`.
#[cfg(unix)]
pub(crate) const CALL_FILE_PREFIX: &str = "call.";

/// Name of the file inside `call.N` that holds the call's argv.
#[cfg(unix)]
pub(crate) const CALL_RECORD_NAME: &str = "argv";

/// Terminator written after the argv of each recorded call.
///
/// It is what tells a reader the call was recorded *whole*: `call.N/argv` is
/// written after the index is claimed, so a call still being written has no
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
/// record directory per call (`call.0/argv`, `call.1/argv`, …) live in `dir`,
/// which the caller owns (a `tempfile::TempDir`).
///
/// ## The recorder is safe for concurrent writers
///
/// More than one process records at once: the PTY backend *spawns* a tmux
/// client (the attach) while the parent keeps making awaited calls. **Each call
/// gets its own directory**, so there is nothing to interleave — the writer
/// claims an index with `mkdir call.N`, then writes only inside it. `mkdir` is
/// a regular utility: it creates the directory atomically, and it fails with an
/// ordinary non-zero status when the name is taken. Nothing about the claim
/// depends on how the shell treats a failing command, which is the property the
/// first attempt lacked.
///
/// That attempt claimed the index with `: > call.N` under `set -C` — an
/// `O_EXCL` create performed by the shell itself, so it spawned no process. It
/// worked here and failed on CI: `:` is a POSIX **special built-in**, and a
/// redirection error on one makes a *non-interactive* shell exit (POSIX XCU
/// 2.8.1). bash 3.2, `/bin/sh` on macOS, tolerates it and carries on; dash,
/// `/bin/sh` on the Linux runner, exits. Measured with dash 0.5.13.5 on the
/// generated script: the first claim succeeds, the second invocation exits 2
/// before recording anything — so on CI every call after the first went
/// unrecorded and eleven FakeTmux tests failed. **No gate in this repo runs
/// dash**: `/bin/sh` on macOS is bash, and that dash came from Homebrew on one
/// machine, so a re-run of that check is not something anyone can rely on. That
/// is the point of choosing a claim with no such dependence — the interpreter
/// difference is not something a local gate could have caught, and it is not
/// something the mechanism relies on being absent. The claim is `mkdir` now
/// because its failure is the utility's own status, on every shell; the price
/// is one process per call (~2.4 ms, measured over the 105 calls
/// `legacy_stage_two_tests` makes: 0.72 s → 0.95 s for that test, against its
/// 10 s create budget). The index scan in front of it uses `[ -e ]`, a builtin,
/// so it spawns nothing.
///
/// The accepted loop was measured too, not only argued: the generated script run
/// under dash 0.5.13.5 records three consecutive calls as three complete
/// `call.N/argv` files with every exit 0, byte-identical to the same script
/// under `/bin/sh` — the shell that killed the rejected one.
///
/// A claim that fails for a reason other than the name being taken (an
/// unwritable directory, no space) is *not* "the index is taken": the writer
/// checks whether the directory now exists, and exits 1 with a diagnostic if it
/// does not, so it fails loudly rather than scanning forever.
///
/// Indices are claimed in order and densely, so `calls()` reads `call.0` upward
/// and stops at the first index nobody holds.
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
/// `a_refused_detach_changes_neither_close_nor_drop`, which raced the pid its
/// spawned child writes, from 30 passes in 30 runs into 23 failures in 30. (One
/// spawn per call, as the claim above costs, failed it 12 of 30 until the test
/// was fixed to wait for that pid — `wait_for_fixture` in `pty.rs` — which is
/// the right shape for a test that races its own fixture either way.)
/// Per-call records cost neither an in-band separator nor a lock.
#[cfg(unix)]
pub(crate) struct FakeTmux {
    bin: String,
    dir: PathBuf,
    socket: PathBuf,
}

/// Install `body` at `bin`, with the file created by a **child** process.
///
/// The path a test execs must never be one this process has open for writing.
/// `fork` copies the whole descriptor table, so while this process holds a write
/// descriptor on that path, every child it forks inherits a copy — and this
/// crate's tests fork constantly, because the PTY and control backends *spawn*
/// tmux clients while other tests keep making awaited calls. `O_CLOEXEC` drops
/// the inherited copy only once that child reaches its own `exec`; until then
/// the inode's write count is positive, and an `exec` of the same path fails
/// with `ETXTBSY` — `Text file busy (os error 26)`, the failure #1026 records.
///
/// So the content goes to a path that is **never exec'd**, and a child `cp`
/// creates the one that is. This process's descriptor table then holds no write
/// descriptor on `bin`, and a fork has nothing to copy.
///
/// `rename` looks like it would do the same and does not: it moves a directory
/// entry, so the inode — and its write count — is the one that was written.
/// Measured on Linux, the kernel CI runs, in the shape these tests have (writer
/// threads plus threads forking continuously, 6000 attempts each): writing in
/// this process gave `ETXTBSY` 49 and then 54; `rename` gave 174 where writing
/// gave 125; this gave 0. Only the zero is evidence — the failure is rare enough
/// that a quiet run on its own would prove nothing.
#[cfg(unix)]
pub(crate) fn install_via_a_child(bin: &Path, body: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let src = bin.with_extension("src");
    std::fs::write(&src, body)?;
    let status = std::process::Command::new("cp").arg(&src).arg(bin).status();
    let _ = std::fs::remove_file(&src);
    if !status?.success() {
        return Err(std::io::Error::other(
            "installing the fake tmux: cp exited with a failure status",
        ));
    }
    // `chmod` does not open the file, so this cannot reintroduce the window.
    let mut perms = std::fs::metadata(bin)?.permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(bin, perms)
}

#[cfg(unix)]
impl FakeTmux {
    /// Write the fake into `dir`. Panics if it cannot be written or made
    /// executable — a fake that silently failed to install would take a test
    /// down a path that looks like the wiring under test.
    pub(crate) fn new(dir: &Path, script: &str) -> Self {
        let bin = dir.join("tmux");
        install_via_a_child(
            &bin,
            &format!(
                "#!/bin/sh\n\
                 if [ \"$1\" = \"-S\" ]; then shift 2; fi\n\
                 n=0\n\
                 while true; do\n\
                 while [ -e \"{dir}/{prefix}$n\" ]; do n=$((n + 1)); done\n\
                 if mkdir \"{dir}/{prefix}$n\" 2>/dev/null; then break; fi\n\
                 if [ ! -d \"{dir}/{prefix}$n\" ]; then\n\
                 echo \"fake tmux: cannot claim {dir}/{prefix}$n\" >&2\n\
                 exit 1\n\
                 fi\n\
                 n=$((n + 1))\n\
                 done\n\
                 printf '%s\\n' \"$@\" > \"{dir}/{prefix}$n/{record}\"\n\
                 echo \"{sep}\" >> \"{dir}/{prefix}$n/{record}\"\n\
                 {script}\n",
                dir = dir.display(),
                prefix = CALL_FILE_PREFIX,
                record = CALL_RECORD_NAME,
                sep = CALL_SEPARATOR,
            ),
        )
        .expect("install the fake tmux");
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
            let claimed = self.dir.join(format!("{CALL_FILE_PREFIX}{n}"));
            // Indices are claimed in order by creating the directory, so the
            // first unclaimed one means there is nothing after it either.
            if !claimed.is_dir() {
                break;
            }
            let text = match std::fs::read_to_string(claimed.join(CALL_RECORD_NAME)) {
                Ok(text) => text,
                // Claimed, but the argv is not on disk yet (or is being written
                // right now). Not a call yet — and later indices may already be
                // complete, so this is not where the scan ends.
                Err(_) => continue,
            };
            // The argv is written after the claim, so a call still being
            // recorded has no terminator: report it only once it is whole.
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
/// claimed before the argv is written, so a claimed index whose argv is absent
/// or unterminated is a call still in flight — reporting it would hand the
/// caller half an argv, and `wait_for_calls` would count it — and the indices
/// are claimed densely and in order, so reading upward cannot skip a call.
#[cfg(unix)]
#[test]
fn a_call_is_reported_only_after_its_terminator() {
    let dir = tempfile::tempdir().unwrap();
    let fake = FakeTmux::new(dir.path(), "exit 0");
    let claim = |n: usize| dir.path().join(format!("{CALL_FILE_PREFIX}{n}"));
    let record = |n: usize| claim(n).join(CALL_RECORD_NAME);

    std::fs::create_dir(claim(0)).unwrap();
    assert_eq!(
        fake.calls(),
        Vec::<Vec<String>>::new(),
        "a claimed index with no argv on disk yet is not a call"
    );

    std::fs::write(record(0), "set-option\n-t\nsess\n").unwrap();
    assert_eq!(
        fake.calls(),
        Vec::<Vec<String>>::new(),
        "a call whose argv is still being written is not a call yet"
    );

    std::fs::write(record(0), "set-option\n-t\nsess\n==call==\n").unwrap();
    std::fs::create_dir(claim(1)).unwrap();
    std::fs::write(record(1), "attach\n-t\nsess\n==call==\n").unwrap();

    let expected: Vec<Vec<String>> = [["set-option", "-t", "sess"], ["attach", "-t", "sess"]]
        .map(|call| call.iter().map(ToString::to_string).collect())
        .to_vec();
    assert_eq!(
        fake.calls(),
        expected,
        "each call reads back as the argv tmux received, in index order"
    );
}
