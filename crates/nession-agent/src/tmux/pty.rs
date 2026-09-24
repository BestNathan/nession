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
///
/// The `TmuxDep` this attaches through is a parameter of [`PtySession::attach`]
/// and is not held: it used to be a field so that [`Drop`] could detach through
/// the same addressing it attached with (#991 step 6), and #1011 removed the
/// spawned `detach-client` that was the field's only reader. Nothing here makes
/// a tmux call after `attach` returns — `set-option` and the attach child are
/// both built from the parameter at attach time, and teardown is the child
/// process — so the seam a test substitutes a fake binary into is the parameter.
pub struct PtySession {
    session_name: String,
    child: Box<dyn Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    viewport: (u16, u16),
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
        // What ends this client is `child.kill()`/`child.wait()` below: `Drop`
        // cannot await, and SIGKILL on a plain attach client is the documented
        // fallback ("less risky than control-mode, but be safe"). That is the
        // *whole* of this teardown — the child is the client.
        //
        // A spawned `detach-client -t <session>` used to sit here as the
        // courteous route to the same end. **Removed in #1011**: measured on
        // tmux 3.6b (2026-09-24), `-t` is a *client* target and a session name
        // is not one, so the call answered `can't find client: <session>`
        // (exit 1) and detached nothing — it had been a no-op since it was
        // written, and it was `let _ =`, so nothing ever said so. The correct
        // target form needs a client name resolved and matched to *this*
        // client, which a `Drop` that cannot await is the wrong place to do;
        // `-s <session>` is not the fix either (it detaches *every* client of
        // the session, including a user's own manual attach).
        //
        // The child is `portable_pty::Child`, the `tmux attach` process this
        // backend spawned — not a tmux call, so no tmux operation class
        // applies: there is no tmux exit status here to classify, only a
        // process to reap, and a reap that fails when the child already exited
        // must not surface as anything.
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
        // client that is gone either way.
        //
        // The spawned `detach-client -t <session>` that used to run first is
        // gone (#1011), for the reason [`Drop`] records: `-t` takes a *client*
        // and a session name is not one, so it could never detach anything.
        // The kill below is what ends the client, and it is all of this path.
        //
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
    async fn closing_a_pty_session_reaps_the_attach_child() {
        // What ends a PTY client is the child reaped by `close`, not a tmux
        // command. That was already the mechanism before #1011 — the only other
        // candidate was a spawned `detach-client -t <session>` that could not
        // work — but #1011 removed the dead call, so this is now the *whole*
        // teardown and the thing a test has to watch.
        //
        // The fake's `attach` branch ignores HUP/TERM/INT and execs `sleep`, so
        // nothing but the reaping ends the child: closing the PTY master on
        // teardown would otherwise hang it up and the test would pass for free.
        // `exec` (rather than a forked `sleep`) keeps the tracked PID the one
        // that receives the signal, leaving no orphan behind. Only SIGKILL —
        // what `portable_pty::Child::kill` sends — ends it.
        //
        // The observation is the PTY channel closing, and a `std::thread`
        // watches it for a reason: `portable_pty::Child::wait` is *blocking*, so
        // a `tokio` timeout wrapped around `close` in this task can never fire
        // (measured: with `kill` dropped, the same test passed after 32s, the
        // child's own `sleep 30` having ended the wait), and a timeout around a
        // *spawned* `close` would instead measure the session's [`Drop`] — which
        // reaps too, and which runs the moment that task ends. The session
        // therefore stays alive here until the assertion has been made.
        //
        // Both mutations of the reaping path are caught, measured: `kill` alone
        // dropped leaves `wait` to be served by the child's own 30s timer, and
        // the whole kill/reap pair dropped leaves the child holding the slave —
        // either way the reader thread keeps its sender and the channel is still
        // open when the deadline passes.
        let deadline = std::time::Duration::from_secs(5);

        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            "case \"$1\" in attach) trap '' HUP TERM INT; exec sleep 30;; *) exit 0;; esac",
        );

        let (mut session, mut rx) = PtySession::attach(&fake.dep(), "nession-fake-sess", 80, 24)
            .expect("the injected binary accepts the attach");
        assert!(
            matches!(
                rx.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty)
            ),
            "the attach child must be alive and holding the PTY before teardown, \
             or the rest of this test would pass for free"
        );

        let reaped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = std::sync::Arc::clone(&reaped);
        let watcher = std::thread::spawn(move || {
            let start = std::time::Instant::now();
            loop {
                if matches!(
                    rx.try_recv(),
                    Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
                ) {
                    observed.store(true, std::sync::atomic::Ordering::SeqCst);
                    return;
                }
                if start.elapsed() >= deadline {
                    return; // leaves `false`: the client outlived the deadline
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        });

        crate::tmux::session::TmuxSession::close(&mut session)
            .await
            .expect("closing is Cleanup: it has no failure to report, and no detach to fail");
        watcher.join().expect("the watcher thread");

        assert!(
            reaped.load(std::sync::atomic::Ordering::SeqCst),
            "close must reap the client itself, not wait for the child's own timer: \
             the PTY channel was still open {deadline:?} after close returned, so \
             the child holding it was not killed"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_injected_tmux_receives_the_attach_and_no_detach() {
        // The attach backend is a tmux client *and* a tmux caller: it sets an
        // option before it attaches. Both of those ran on the process-wide tmux
        // before #991 step 6 and run on whatever the caller passes now.
        //
        // This is the wiring that a test cannot check through results: against
        // the real binary the calls succeed whether or not the injection took.
        // What is checked instead is the fake's own record — which is also why
        // the session name is one no real tmux has ever heard of: if the real
        // binary were reached, `set-option` on a session that does not exist
        // would be the only thing that happened, and the recorded calls would
        // not be there at all.
        //
        // **The absence half is the #1011 regression guard.** Teardown used to
        // spawn a third call here — `detach-client -t <session_name>` — and on
        // tmux 3.6b (measured 2026-09-24) that is not a valid target: `-t`
        // takes a *client*, a session name is not one, and the answer was
        // `can't find client: <session>` (exit 1). It detached nothing for as
        // long as it existed. Re-adding it would re-add a no-op; the fake
        // records every argv it was given, so a detach that came back lands in
        // this assertion.
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
        // The removed call was `status()`-shaped — awaited inside `Drop` — so
        // it would be recorded before `drop` returned. The settle covers a
        // re-added *spawned* one, which the fake (a separate process appending
        // to one file) could record a moment after teardown.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let calls = fake.calls();
        assert!(
            !calls
                .iter()
                .any(|args| args.first().map(String::as_str) == Some("detach-client")),
            "teardown must not spawn `detach-client`: `-t` takes a client and a \
             session name is not one, so the call was a no-op (#1011), and the \
             child kill/reap is what ends the client: {calls:?}"
        );
    }
}
