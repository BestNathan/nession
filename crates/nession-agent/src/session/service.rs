//! The Agent's Session service (#2469 slice 3).
//!
//! One service per Agent process: it owns the tmux-facing policy (which
//! `SessionManager`, which attach mode) and is the only place a terminal
//! backend is constructed. A transport handler asks for a Session's backend;
//! it never names `PtySession` or `ControlModeSession` itself.

use std::sync::Arc;

use anyhow::Result;
use tokio::sync::{mpsc, watch};

use crate::config::AttachMode;
use crate::tmux::control::{ControlModeSession, OutputStream};
use crate::tmux::manager::SessionManager;
use crate::tmux::pty::PtySession;

/// The one Session service the Agent composes.
pub struct SessionService {
    tmux: Arc<SessionManager>,
    attach_mode: AttachMode,
}

impl SessionService {
    pub fn new(tmux: Arc<SessionManager>, attach_mode: AttachMode) -> Self {
        Self { tmux, attach_mode }
    }

    /// The tmux manager every Session operation runs on.
    pub fn tmux(&self) -> &Arc<SessionManager> {
        &self.tmux
    }

    /// How this Agent attaches to tmux (plain PTY or Control Mode).
    pub fn attach_mode(&self) -> &AttachMode {
        &self.attach_mode
    }

    /// Attach one Session's terminal backend.
    ///
    /// `capture_lines` is the Control Mode bootstrap capture size; the plain
    /// PTY backend takes its history from a separate tmux process and ignores
    /// it.
    pub async fn attach(
        &self,
        session_name: &str,
        width: u16,
        height: u16,
        capture_lines: Option<u32>,
    ) -> Result<AttachedBackend> {
        let tmux = self.tmux.tmux_dep();
        match self.attach_mode {
            AttachMode::Plain => {
                let (session, output) = PtySession::attach(&tmux, session_name, width, height)?;
                Ok(AttachedBackend::Plain {
                    session: Box::new(session),
                    output,
                })
            }
            AttachMode::Control => {
                let (session, output, resize, capture) =
                    ControlModeSession::attach(&tmux, session_name, width, height, capture_lines)
                        .await?;
                Ok(AttachedBackend::Control {
                    session: Box::new(session),
                    output,
                    resize,
                    capture,
                })
            }
        }
    }
}

/// One attached backend, in the transport's own terms.
pub enum AttachedBackend {
    /// A plain PTY client with its raw byte receiver.
    Plain {
        session: Box<PtySession>,
        output: mpsc::Receiver<Vec<u8>>,
    },
    /// A Control Mode client with its ordered output, authoritative resize
    /// level and bootstrap capture when one was requested.
    Control {
        session: Box<ControlModeSession>,
        output: OutputStream,
        resize: watch::Receiver<(u16, u16)>,
        capture: Option<Vec<u8>>,
    },
}
