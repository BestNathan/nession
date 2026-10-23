//! The transport seam under [`super::TmuxClient`].
//!
//! The client owns framing, command dispatch and event ordering; a transport
//! owns only "spawn a process (or take a byte-stream pair) and hand back its
//! stdin/stdout". That split is what lets the same client run over
//! `tmux -C` pipes today and `tmux -CC` on a PTY later (#2307 slice D) without
//! touching the protocol logic again.
//!
//! The pipe transport still spawns through [`TmuxCmd`](crate::tmux::cmd::TmuxCmd)
//! — the single owner of `-S <private socket>` addressing and inherited-env
//! scrubbing — so this module adds no second tmux process grammar.

use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::process::{Child, ChildStdin, ChildStdout};

use crate::tmux::ops::TmuxDep;

/// One attached control client's byte streams.
///
/// `child` is present for a real process and absent for an in-memory wire (the
/// deterministic tests). The client never inspects the process; it only reaps
/// it on close so a detached tmux does not linger as a zombie.
pub struct ClientIo {
    pub reader: Box<dyn AsyncRead + Unpin + Send>,
    pub writer: Box<dyn AsyncWrite + Unpin + Send>,
    pub child: Option<Child>,
}

/// `tmux -C attach` over separate stdin/stdout pipes.
///
/// `-C` (not `-CC`) is the initial production default: it needs no PTY and the
/// control-mode grammar is identical. The PTY transport is a separate deliverable
/// (#2307 SC-02), not a substitution made here.
pub struct PipeTransport;

impl PipeTransport {
    /// Spawn one control attachment to `session_name` on the caller's private
    /// socket.
    pub fn connect(tmux: &TmuxDep, session_name: &str) -> Result<ClientIo> {
        let mut child = tmux
            .cmd()
            .tokio()
            .args(["-C", "attach", "-t", session_name])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("failed to spawn tmux -C attach -t {session_name}"))?;
        let stdin: ChildStdin = child
            .stdin
            .take()
            .context("control child stdin was not piped")?;
        let stdout: ChildStdout = child
            .stdout
            .take()
            .context("control child stdout was not piped")?;
        Ok(ClientIo {
            reader: Box::new(stdout),
            writer: Box::new(stdin),
            child: Some(child),
        })
    }
}
