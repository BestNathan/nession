//! Answers "where is this Session's shell?" for the git capability.
//!
//! #750 C2 puts the repository boundary agent-side: the client may not name a
//! path, so the directory git runs in has to be discovered from the Session
//! itself. A tmux session is a shell the user can `cd` in at any moment, so
//! this asks tmux for the active pane's current path rather than caching a
//! value that was true when the session was created.
//!
//! `nession-git` deliberately does not know this: it takes a
//! [`WorkdirResolver`](nession_git::WorkdirResolver) so it never addresses a
//! tmux socket, and the tmux socket discipline stays in one module
//! (`tmux::cmd`). This is the adapter that joins the two.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use nession_git::WorkdirResolver;

use crate::server::websocket::extract_session_name;
use crate::tmux::manager::SessionManager;

pub struct TmuxWorkdirResolver {
    tmux: Arc<SessionManager>,
}

impl TmuxWorkdirResolver {
    pub fn new(tmux: Arc<SessionManager>) -> Self {
        Self { tmux }
    }
}

#[async_trait]
impl WorkdirResolver for TmuxWorkdirResolver {
    async fn resolve(&self, session: &str) -> Option<PathBuf> {
        // Session ids arrive as `agent:name`; tmux knows the name half. Same
        // normalisation the file-cwd path uses, so both agree on which session
        // a given id refers to.
        let name = extract_session_name(session);
        if name.is_empty() {
            return None;
        }

        // A failure here is not an error the caller can act on — the session
        // may simply have exited between the request and this call. `None`
        // becomes the "we cannot address a repository" answer, which is the
        // honest response rather than a guess at a path.
        match self.tmux.get_session_cwd(&name).await {
            Ok(path) if !path.trim().is_empty() => Some(PathBuf::from(path.trim())),
            Ok(_) => None,
            Err(err) => {
                tracing::debug!(session = %name, error = %err, "git: session cwd unavailable");
                None
            }
        }
    }
}
