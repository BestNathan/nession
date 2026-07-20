//! Plain PTY-based tmux attach session.
//!
//! Uses a real PTY (pseudo-terminal) via `portable-pty`.  A single
//! `tmux attach` subprocess runs on the slave side; the agent reads
//! raw ANSI bytes from the master and forwards them to all connected
//! web clients.  Resize, redraw, and multi-client are handled natively
//! by tmux — no `-C` control-mode parsing required.

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

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

        // Build the command using portable-pty's CommandBuilder
        // and spawn it on the slave side of the PTY.
        let mut cmd = CommandBuilder::new("tmux");
        cmd.args(["attach", "-t", session_name]);
        let child = pty
            .slave
            .spawn_command(cmd)
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
        std::thread::spawn(move || {
            let mut buf = vec![0u8; READ_BUF_SIZE];
            loop {
                let n = reader.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break; // EOF — tmux subprocess exited
                }
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
        // Kill the tmux subprocess when the session struct is dropped.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
