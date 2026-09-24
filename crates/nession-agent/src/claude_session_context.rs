//! The host side of the Claude Code capability's session boundary (#1005).
//!
//! `nession-claude-code` declares what it needs ([`SessionContext`]); this is
//! the only thing that can answer, because the agent is what owns session
//! lifecycle and addresses tmux.
//!
//! ## The session id is normalised the same way git's resolver normalises it
//!
//! [`extract_session_name`] turns `agent:name` into `name`, and
//! `git_workdir.rs` uses it for exactly this. Using it here too is not tidiness:
//! if this file normalised differently, a conversation request and a git request
//! carrying the same id would address *different sessions*, and the capability
//! would show one session's Claude conversation beside another's repository —
//! both answers individually plausible.

use std::sync::Arc;

use async_trait::async_trait;
use nession_claude_code::binding::Binding;
use nession_claude_code::session_context::SessionContext;

use crate::server::websocket::extract_session_name;
use crate::tmux::manager::SessionManager;

/// Answers from the agent's own tmux addressing.
pub struct TmuxSessionContext {
    tmux: Arc<SessionManager>,
}

impl TmuxSessionContext {
    pub fn new(tmux: Arc<SessionManager>) -> Self {
        Self { tmux }
    }
}

/// The command names that mean "Claude Code is running here".
///
/// `claude.exe` is in the list because a real Claude Code install reports that
/// on some platforms — the Web projection already recognises both, and this
/// must agree with it rather than form a second opinion.
const CLAUDE_COMMANDS: [&str; 2] = ["claude", "claude.exe"];

#[async_trait]
impl SessionContext for TmuxSessionContext {
    /// The session's working directory, as tmux reports it.
    ///
    /// `None` rather than an error for every way this can fail: the session may
    /// have exited between the request and this call, the tmux server may be
    /// gone, or the id may name a session this agent never had. All of those
    /// mean "cannot say", and `#1005` requires that to be reported rather than
    /// guessed at — a wrong cwd would silently produce another session's
    /// conversation.
    async fn session_cwd(&self, session_id: &str) -> Option<String> {
        let name = extract_session_name(session_id);
        if name.is_empty() {
            return None;
        }
        match self.tmux.get_session_cwd(&name).await {
            Ok(path) if !path.trim().is_empty() => Some(path.trim().to_string()),
            Ok(_) => None,
            Err(err) => {
                tracing::debug!(session = %name, error = %err, "claude-code: session cwd unavailable");
                None
            }
        }
    }

    /// Whether Claude Code is the pane's foreground command right now.
    ///
    /// No pane answer is `None`, not `false`: "Claude is not running" and "this
    /// agent cannot see the pane" are different claims, and only the first is
    /// safe to show a user as "this conversation is finished".
    async fn session_claude_active(&self, session_id: &str) -> Option<bool> {
        let name = extract_session_name(session_id);
        if name.is_empty() {
            return None;
        }
        match self.tmux.get_session_command(&name).await {
            Ok(command) => {
                let base = command.trim();
                Some(CLAUDE_COMMANDS.contains(&base))
            }
            Err(err) => {
                tracing::debug!(session = %name, error = %err, "claude-code: session command unavailable");
                None
            }
        }
    }

    /// The binding this session's Claude reported, read from the agent's own
    /// state directory.
    ///
    /// The path comes from [`claude_binding::file_for`], which is also what the
    /// hook was handed — see that module for why the derivation is shared
    /// rather than repeated. The session id is normalised the same way every
    /// other lookup here normalises it, so a request naming `agent:s` reads the
    /// binding filed under `s`.
    ///
    /// Nothing is created here. A missing file is the ordinary state for a
    /// session whose Claude has not started, so this is a read on a path that
    /// usually does not exist yet — and it must not be the thing that creates
    /// the directory, because the answer to "is it there" would then always be
    /// yes.
    async fn session_claude_binding(&self, session_id: &str) -> Option<Binding> {
        let name = extract_session_name(session_id);
        if name.is_empty() {
            return None;
        }
        let path = crate::claude_binding::file_for(&name)?;

        // A small file read, but still file I/O on an async worker — the same
        // treatment every other blocking read in this crate gets.
        match tokio::task::spawn_blocking(move || nession_claude_code::binding::read(&path)).await {
            Ok(binding) => binding,
            Err(err) => {
                tracing::debug!(session = %name, error = %err, "claude-code: binding read task failed");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_recognised_command_names_are_the_ones_the_web_projection_uses() {
        // Pinned together on purpose: if the projection learns a third spelling
        // and this does not, the terminal would say Claude is running while the
        // conversation said it had stopped.
        assert!(CLAUDE_COMMANDS.contains(&"claude"));
        assert!(CLAUDE_COMMANDS.contains(&"claude.exe"));
    }

    #[tokio::test]
    async fn an_id_with_no_session_name_resolves_to_nothing() {
        // `extract_session_name("")` is empty, and asking tmux for the empty
        // session name would address something rather than nothing.
        let context = TmuxSessionContext::new(Arc::new(SessionManager::new()));
        assert_eq!(context.session_cwd("").await, None);
        assert_eq!(context.session_claude_active("").await, None);
    }
}
