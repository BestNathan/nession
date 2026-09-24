//! Plain PTY-based tmux attach session.
//!
//! Uses a real PTY (pseudo-terminal) via `portable-pty`.  A single
//! `tmux attach` subprocess runs on the slave side; the agent reads
//! raw ANSI bytes from the master and forwards them to all connected
//! web clients.  Resize, redraw, and multi-client are handled natively
//! by tmux — no `-C` control-mode parsing required.

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tracing::error;

use super::ops::TmuxDep;

/// Buffer size for reading from the PTY master — 4 KiB per read.
const READ_BUF_SIZE: usize = 4096;

/// One PTY-based tmux session, shared by all attached web clients.
///
/// The reader and writer are each wrapped in `Arc<Mutex<...>>` so
/// multiple tasks can write input concurrently.  Resize calls go
/// directly through the stored `MasterPty` (the method takes `&self`,
/// so no locking is needed).
pub struct PtySession {
    session_name: String,
    child: Box<dyn Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    viewport: (u16, u16),
    /// The tmux this backend attaches and detaches through — held rather than
    /// resolved per call because [`Drop`] cannot reach the process: a client
    /// that was attached with one addressing must be detached from the same
    /// one (#991 step 6).
    tmux: TmuxDep,
}

impl PtySession {
    /// Open a PTY, spawn `tmux attach -t <session_name>`, and return
    /// the session plus a receiver for raw ANSI output bytes.
    ///
    /// The returned `mpsc::Receiver<Vec<u8>>` yields chunks of ANSI
    /// data read from the PTY master.  The caller should forward these
    /// to all connected web clients as `terminal.output` messages.
    ///
    /// `tmux` is the caller's addressing — the same one the session was
    /// created on, and the one a test substitutes a fake binary into.
    pub fn attach(
        tmux: &TmuxDep,
        session_name: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(Self, mpsc::Receiver<Vec<u8>>)> {
        let pty_system = native_pty_system();
        let pty = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open PTY")?;

        // Hide the tmux status bar for this session only — the web UI has
        // its own chrome.  Using `-t` instead of `-g` avoids a global
        // side-effect that would affect every session on the machine.
        //
        // **BestEffort** (#991 open question 4, decided here). What breaks if
        // this fails: the attached client sees tmux's own status line in the
        // last row of the grid — visual noise in a client whose chrome is the
        // web UI's. What does not break: the attach, the pane, and every byte
        // of its content. It is a *presentation* option applied to the client
        // being opened, not a prerequisite for opening it, so `?` here would
        // make a cosmetic preference able to fail an attach. Measured on tmux
        // 3.6b: when the option is refused, the refusal is `no such session:
        // <name>` (exit 1) — a session the attach itself cannot survive either,
        // which is exactly why it must not be *this* call that reports it.
        //
        // Observable rather than dropped (#991: "no silent accidental
        // policy"): the failure names the option and carries tmux's stderr.
        // `.std()` + `.output()` rather than `.status()`, because a status-only
        // call has no pipes to carry tmux's reason.
        let mut status_bar = tmux.cmd().std();
        status_bar.args(["set-option", "-t", session_name, "status", "off"]);
        match status_bar.output() {
            Ok(out) if out.status.success() => {}
            Ok(out) => tracing::warn!(
                "best-effort `set-option status off` for session {session_name} failed ({}): {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ),
            Err(e) => tracing::warn!(
                "best-effort `set-option status off` for session {session_name} failed to spawn: {e}"
            ),
        }

        // Build the command using portable-pty's CommandBuilder
        // and spawn it on the slave side of the PTY.  portable-pty has its own
        // command type, so this goes through TmuxCmd::pty() rather than the
        // std/tokio builders — the socket flag has to be applied per API.
        let mut attach = tmux.cmd().pty();
        attach.args(["attach", "-t", session_name]);
        let child = pty
            .slave
            .spawn_command(attach)
            .with_context(|| format!("failed to spawn tmux attach -t {session_name}"))?;

        // Obtain separate reader + writer handles from the master PTY.
        // try_clone_reader creates a new readable fd, take_writer moves
        // the writable fd out so it can be shared across threads.
        let mut reader = pty
            .master
            .try_clone_reader()
            .context("failed to clone PTY reader")?;
        let writer = pty
            .master
            .take_writer()
            .context("failed to take PTY writer")?;

        let writer = Arc::new(Mutex::new(writer));
        let (tx, rx) = mpsc::channel(64);

        // Spawn a blocking reader task — PTY I/O is synchronous, so we
        // use std::thread::spawn to avoid blocking the async runtime.
        let session_name_owned = session_name.to_string();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; READ_BUF_SIZE];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) => break, // EOF — tmux subprocess exited
                    Ok(n) => n,
                    Err(e) => {
                        error!("PTY read error for session {}: {e}", session_name_owned);
                        break;
                    }
                };
                let chunk = buf.get(..n).unwrap_or(&[]);
                if tx.blocking_send(chunk.to_vec()).is_err() {
                    break; // receiver dropped
                }
            }
        });

        Ok((
            Self {
                session_name: session_name.to_string(),
                child,
                writer,
                master: pty.master,
                viewport: (cols, rows),
                tmux: tmux.clone(),
            },
            rx,
        ))
    }

    /// Write raw input bytes to the PTY (forwarded to tmux).
    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self
            .writer
            .lock()
            .map_err(|_| anyhow::anyhow!("PTY writer lock poisoned"))?;
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    /// Resize the PTY.  tmux receives SIGWINCH and reflows automatically.
    ///
    /// The PTY is this attach client's own size, but the pane it produces is
    /// not private: with tmux's default `window-size latest` the window follows
    /// the client, so this moves the **shared** window for every other client
    /// on the session — the same resource `ControlModeSession::resize` moves,
    /// by a different route. See `manager.rs`'s `SESSION_WIDTH`.
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.viewport = (cols, rows);
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// Current viewport dimensions.
    pub fn viewport(&self) -> (u16, u16) {
        self.viewport
    }

    /// Session name.
    pub fn session_name(&self) -> &str {
        &self.session_name
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // **Cleanup** (#991): a teardown path, and its failure is allowed —
        // but it must not become anyone's error and must not panic, which is
        // why the shape is `let _ =` and not `?`.
        //
        // What actually ends this client is `child.kill()`/`child.wait()`
        // below: `Drop` cannot await, and SIGKILL on a plain attach client is
        // the documented fallback ("less risky than control-mode, but be
        // safe"). Detaching first is the courteous route to the same end.
        //
        // **Measured on tmux 3.6b (2026-09-24): `-t` is a *client* target and a
        // session name is not one** — this call answers `can't find client:
        // <session>` (exit 1) and detaches nothing, so the detach has been a
        // no-op since it was written. The class is `Cleanup` either way and the
        // silence is deliberate: the child kill is what reaps the client, and
        // warning on every teardown would be an alarm nobody can act on here.
        // The target form is a client-lifecycle question (`-s <session>`
        // detaches *every* client of the session, including a user's own manual
        // attach), so it is not decided by this step — see #991 step 8/9.
        let _ = self
            .tmux
            .cmd()
            .std()
            .args(["detach-client", "-t", &self.session_name])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        // Reap the PTY child. Not a tmux call: this is `portable_pty::Child`,
        // the `tmux attach` process this backend spawned, so no tmux
        // operation class applies — there is no tmux exit status here to
        // classify, only a process to reap, and a reap that fails when the
        // child already exited must not surface as anything.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[async_trait::async_trait]
impl super::session::TmuxSession for PtySession {
    async fn write_input(&mut self, data: &[u8]) -> Result<()> {
        // PtySession::write takes &self (the writer is internally locked),
        // so the &mut receiver here simply satisfies the trait signature.
        self.write(data)
    }

    async fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        PtySession::resize(self, cols, rows)
    }

    fn viewport(&self) -> (u16, u16) {
        PtySession::viewport(self)
    }

    fn session_name(&self) -> &str {
        PtySession::session_name(self)
    }

    async fn close(&mut self) -> Result<()> {
        // **Cleanup**, not `Required`, and the class is why this returns `Ok`
        // to its caller: closing is the teardown itself, so its failure has no
        // primary operation left to invalidate — what a caller can act on is
        // the *session* teardown (`SessionManager::kill_session`, which is
        // `Required` and reports tmux's own words), not whether a client had to
        // be killed instead of detaching. `?` here would report an error for a
        // client that is gone either way. Same measured target-form note as
        // [`Drop`]: `-t <session>` is not a client target, so this detach does
        // not happen, and the kill below is what ends the client.
        let _ = self
            .tmux
            .cmd()
            .std()
            .args(["detach-client", "-t", &self.session_name])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        // Not a tmux call — the PTY child process, as in `Drop`.
        let _ = self.child.kill();
        let _ = self.child.wait();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tmux::cmd;
    use std::time::{Duration, Instant};

    /// Harness socket env var — set by `scripts/tmux-run-socket.sh` (via
    /// `just test` / `filtered-test.sh`). The regression test below only runs
    /// under it: without it, `cmd::global()` would fall back to the default
    /// `/tmp/nession-<uid>/tmux.sock`, which a dev agent may be serving.
    const HARNESS_SOCKET_ENV: &str = "NESSION_TMUX_SOCKET";

    fn harness_socket() -> Option<String> {
        std::env::var(HARNESS_SOCKET_ENV).ok()
    }

    fn tmux_available() -> bool {
        // Through cmd::global() like every other tmux call — the
        // check-tmux-socket gate rejects raw `Command::new("tmux")` even in
        // tests, and -V needs no server so this is harmless on any socket.
        cmd::global()
            .std()
            .arg("-V")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
    }

    #[test]
    fn attach_survives_when_the_agent_env_has_no_term() {
        // Regression for #633: `PtySession::attach` spawns the tmux client as
        // a child of the agent, and an agent started with an unusable $TERM
        // (CI runners export TERM=dumb or nothing; docker/systemd usually
        // have none) used to make tmux fail with "terminal does not support
        // clear" — the client died instantly and the session showed no
        // output. The pty command pins TERM=xterm-256color (cmd.rs), so
        // attach must survive even when this test process itself carries a
        // broken TERM. Locally, run it with `TERM=dumb` to exercise the CI
        // shape; CI itself runs without a usable TERM.
        let Some(_socket) = harness_socket() else {
            eprintln!("skipped: {HARNESS_SOCKET_ENV} not set (test-harness run only)");
            return;
        };
        if !tmux_available() {
            eprintln!("skipped: tmux not on PATH");
            return;
        }

        // Unique session on the harness socket — never the default one.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!("nession_pty_noterm_{nanos:016x}");

        let created = cmd::global()
            .std()
            .args(["new-session", "-d", "-s", &name, "-x", "80", "-y", "24"])
            .status();
        assert!(
            created.is_ok_and(|s| s.success()),
            "failed to create tmux session {name} on the harness socket"
        );

        let (session, mut rx) = match PtySession::attach(&TmuxDep::global(), &name, 80, 24) {
            Ok(pair) => pair,
            Err(e) => {
                let _ = cmd::global()
                    .std()
                    .args(["kill-session", "-t", &name])
                    .status();
                panic!("attach failed for session {name}: {e:#}");
            }
        };

        // A usable tmux client stays attached and error-free: with a broken
        // TERM (CI runners export TERM=dumb or nothing) the client dies right
        // after printing "terminal does not support clear", the PTY read
        // hits EOF and the channel disconnects. Collect for a grace period,
        // then require the client to still be connected.
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut error_signature = false;
        let mut alive = true;
        while Instant::now() < deadline {
            match rx.try_recv() {
                Ok(chunk) => {
                    let text = String::from_utf8_lossy(&chunk);
                    error_signature |= text.contains("terminal does not support clear")
                        || text.contains("open terminal failed");
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {}
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                    alive = false;
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            alive,
            "tmux attach client disconnected within 1s — the child likely died \
             from an unusable TERM (see #633)"
        );
        assert!(
            !error_signature,
            "tmux attach reported a terminal error — TERM must be pinned \
             to xterm-256color (see #633)"
        );

        drop(session); // detaches the client and reaps the child
        let killed = cmd::global()
            .std()
            .args(["kill-session", "-t", &name])
            .status();
        assert!(
            killed.is_ok_and(|s| s.success()),
            "failed to clean up session {name}"
        );
    }

    #[test]
    fn test_pty_session_attach_spawns_tmux_subprocess() {
        // PtySession::attach creates a PTY and spawns tmux.  When tmux is
        // on PATH the spawn itself succeeds (Ok) even if the session does
        // not exist.  When tmux is absent the spawn fails (Err).  Either
        // outcome is valid for this test — we verify only that the
        // returned struct is well-constructed on the Ok path and that
        // there is no panic or hang on either path.
        let result = PtySession::attach(&TmuxDep::global(), "__nession_test_session__", 80, 24);
        if let Ok((session, _rx)) = result {
            assert_eq!(session.session_name(), "__nession_test_session__");
            assert_eq!(session.viewport(), (80, 24));
            drop(session);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_refused_status_option_does_not_stop_the_attach() {
        // #991 open question 4, decided at the call site: `set-option status
        // off` is `BestEffort` — hiding tmux's status bar is what the web UI's
        // own chrome replaces, so a tmux that refuses it yields a client with
        // one noisy row, not a client that cannot be opened. The fake refuses
        // it (with tmux's real wording for a target that is not there, measured
        // on 3.6b) and the attach still stands.
        //
        // Reddens on: propagating the failure (`?` — the `expect` below fails),
        // and on dropping the call (the recorded-call assertion fails).
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            "case \"$1\" in set-option) echo 'no such session: nession-fake-sess' >&2; exit 1;; \
             *) exit 0;; esac",
        );

        let (session, _rx) = PtySession::attach(&fake.dep(), "nession-fake-sess", 80, 24)
            .expect("a refused status option must not fail the attach");
        assert_eq!(session.viewport(), (80, 24));

        assert_eq!(
            fake.calls().first(),
            Some(&vec![
                "set-option".to_string(),
                "-t".to_string(),
                "nession-fake-sess".to_string(),
                "status".to_string(),
                "off".to_string(),
            ]),
            "the attempt is still made, targeted at this session and not globally: {:#?}",
            fake.calls()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_refused_detach_changes_neither_close_nor_drop() {
        // The `Cleanup` class, at both teardown paths: `close` returns `Ok`
        // even when the detach is refused, and `Drop` does not panic. What ends
        // the client in both is the child kill/reap below the detach, which is
        // why the class tolerates the failure — and why propagating it would be
        // wrong: a caller would be told the close failed for a client that is
        // gone either way.
        //
        // The fake answers with the measurement this step took on tmux 3.6b:
        // `-t` takes a *client* target, so a session name is not one and the
        // call has always failed (`can't find client: <session>`, exit 1). Its
        // silence in the old `let _ =` is the point of the class statement
        // beside it — the teardown that actually happens is the process one.
        //
        // Reddens on: making `close` propagate the detach failure.
        //
        // The evidence is a sentinel file rather than a line of the fake's argv
        // log: this backend *spawns* a tmux client, so the attach child and the
        // detach command are two processes appending to one log at once, and
        // `FakeTmux` writes a call's argv one entry at a time. A per-call
        // assertion there is racy — measured, 3 runs in 10 spliced the two
        // calls' entries together — while `: > <file>` in the refusing branch is
        // atomic and says exactly what this test needs: the branch that refuses
        // was reached. (The harness race is real and not mine to fix here; the
        // other fake-based tests assert on awaited calls, which cannot overlap.)
        let dir = tempfile::tempdir().expect("tempdir");
        let sentinel = dir.path().join("detach-ran");
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            &format!(
                "case \"$1\" in detach-client) : > \"{sent}\"; \
                 echo 'cant find client: nession-fake-sess' >&2; exit 1;; \
                 *) exit 0;; esac",
                sent = sentinel.display(),
            ),
        );

        let (mut session, _rx) = PtySession::attach(&fake.dep(), "nession-fake-sess", 80, 24)
            .expect("the injected binary accepts the attach");
        crate::tmux::session::TmuxSession::close(&mut session)
            .await
            .expect("a refused detach is Cleanup, not a close failure");
        assert!(
            sentinel.exists(),
            "the detach really was attempted, and refused by the injected binary: {:#?}",
            fake.calls()
        );

        // And the Drop path, with the same refusing fake: reaching the end of
        // this test without a panic is the assertion.
        drop(session);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_injected_tmux_receives_the_attach_and_the_detach() {
        // The attach backend is a tmux client *and* a tmux caller: it sets an
        // option before it attaches, and it detaches on the way out. All three
        // of those ran on the process-wide tmux before #991 step 6 and run on
        // whatever the caller passes now.
        //
        // This is the wiring that a test cannot check through results: against
        // the real binary the calls succeed whether or not the injection took.
        // What is checked instead is the fake's own record — which is also why
        // the session name is one no real tmux has ever heard of: if the real
        // binary were reached, `set-option` on a session that does not exist
        // would be the only thing that happened, and the recorded calls would
        // not be there at all.
        //
        // No tmux and no harness socket: unlike the integration tests that skip
        // on macOS, this one never runs control-mode/PTY against a real server,
        // so it has no reason to skip anywhere.
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::test_support::FakeTmux::new(dir.path(), "exit 0");

        let (session, _rx) = PtySession::attach(&fake.dep(), "nession-fake-sess", 80, 24)
            .expect("the injected binary exists, so the PTY spawn succeeds");
        assert_eq!(session.viewport(), (80, 24));

        // The attach is a spawned child rather than an awaited call, so its
        // record can be a moment behind the spawn; `set-option` is `.status()`
        // and is already there.
        let calls = fake
            .wait_for_calls(2, std::time::Duration::from_secs(10))
            .await;
        assert_eq!(
            calls.first(),
            Some(&vec![
                "set-option".to_string(),
                "-t".to_string(),
                "nession-fake-sess".to_string(),
                "status".to_string(),
                "off".to_string(),
            ]),
            "the status bar is hidden on the injected tmux, targeted at the session: {calls:?}"
        );
        assert!(
            calls.iter().any(|args| args
                == &vec![
                    "attach".to_string(),
                    "-t".to_string(),
                    "nession-fake-sess".to_string(),
                ]),
            "the PTY child must be the injected binary attaching to the session: {calls:?}"
        );

        drop(session);
        let calls = fake.calls();
        assert!(
            calls.iter().any(|args| args
                == &vec![
                    "detach-client".to_string(),
                    "-t".to_string(),
                    "nession-fake-sess".to_string(),
                ]),
            "dropping the session detaches its client from the same tmux it \
             attached to: {calls:?}"
        );
    }
}
