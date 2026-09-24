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
        let _ = tmux
            .cmd()
            .std()
            .args(["set-option", "-t", session_name, "status", "off"])
            .status();

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
        // Detach the tmux client gracefully using a blocking command (Drop is
        // sync so we cannot wait on the async child).  SIGKILL on a tmux
        // attach client is less risky than control-mode, but be safe.
        let _ = self
            .tmux
            .cmd()
            .std()
            .args(["detach-client", "-t", &self.session_name])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        // Best-effort reap — the child has likely exited after detach.
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
        // Detach the tmux client gracefully before killing the subprocess.
        let _ = self
            .tmux
            .cmd()
            .std()
            .args(["detach-client", "-t", &self.session_name])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        // Best-effort reap — child should have exited after detach.
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
