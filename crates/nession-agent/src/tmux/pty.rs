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

use super::cmd;

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
}

impl PtySession {
    /// Open a PTY, spawn `tmux attach -t <session_name>`, and return
    /// the session plus a receiver for raw ANSI output bytes.
    ///
    /// The returned `mpsc::Receiver<Vec<u8>>` yields chunks of ANSI
    /// data read from the PTY master.  The caller should forward these
    /// to all connected web clients as `terminal.output` messages.
    pub fn attach(
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
        let _ = cmd::global()
            .std()
            .args(["set-option", "-t", session_name, "status", "off"])
            .status();

        // Build the command using portable-pty's CommandBuilder
        // and spawn it on the slave side of the PTY.  portable-pty has its own
        // command type, so this goes through TmuxCmd::pty() rather than the
        // std/tokio builders — the socket flag has to be applied per API.
        let mut attach = cmd::global().pty();
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
        let _ = cmd::global()
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
        let _ = cmd::global()
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

        let (session, mut rx) = match PtySession::attach(&name, 80, 24) {
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
        let result = PtySession::attach("__nession_test_session__", 80, 24);
        if let Ok((session, _rx)) = result {
            assert_eq!(session.session_name(), "__nession_test_session__");
            assert_eq!(session.viewport(), (80, 24));
            drop(session);
        }
    }
}
