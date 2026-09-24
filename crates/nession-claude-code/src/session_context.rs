//! What the host knows about a Nession session, and this provider cannot learn
//! on its own (#1005 scope 1).
//!
//! ## Why this is a trait here rather than a call into the agent
//!
//! This provider needs a session's working directory to answer "which
//! conversation is this Session in" — the cwd is the whole basis of the
//! candidate list (#1005 decision 7). The agent already knows it:
//! `SessionManager::get_session_cwd` asks tmux for `#{pane_current_path}`.
//!
//! The obvious way to reach it — have `nession-claude-code` call
//! `nession-agent` — is forbidden, and not as a style preference. The agent
//! host is what *composes* extensions; an extension that depends back on its
//! host cannot be built, tested, or replaced on its own, and the dependency
//! graph stops being a graph.
//!
//! So the direction is inverted: the provider declares what it needs, and the
//! host that already has it supplies it. `#1005` names construct-time injection
//! as an acceptable shape, and it is the only one here that leaves
//! [`AgentExtension`](nession_common::extension::AgentExtension) — shared by
//! every provider — untouched.

use async_trait::async_trait;

use crate::binding::Binding;

/// The host's view of Nession sessions.
///
/// Implemented by the agent host, which is the only thing that owns session
/// lifecycle. Object-safe and injected as `Arc<dyn SessionContext>` so a test
/// can supply a session that does not exist.
#[async_trait]
pub trait SessionContext: Send + Sync {
    /// The working directory of `session_id`, when the host can resolve it.
    ///
    /// `None` is a real answer and not an error: the session may have ended, the
    /// tmux server may be unreachable, or the id may be one this host never
    /// knew. Every one of those means "cannot say", which is what `#1005`'s
    /// first constraint requires to be reported rather than guessed at.
    async fn session_cwd(&self, session_id: &str) -> Option<String>;

    /// Whether Claude Code is the foreground command in `session_id` right now.
    ///
    /// `None` when the host cannot say — a session that has ended, or a tmux
    /// that will not answer. That is not `Some(false)`: "Claude is not running"
    /// and "I cannot tell" are different claims, and `#1005` criterion 4 turns
    /// on the first while forbidding anything that would be invented from the
    /// second.
    ///
    /// The agent answers this from the pane's foreground command, which is the
    /// same signal the Web projection already uses to decide the capability is
    /// `active` — so the two cannot disagree about whether Claude is running.
    async fn session_claude_active(&self, session_id: &str) -> Option<bool>;

    /// The Claude session `session_id` was bound to, when one has reported.
    ///
    /// This is the only answer here that resolves *which* conversation a Session
    /// is in, and it exists because nothing else can. A cwd narrows the field to
    /// a candidate list and stops there: two Nession sessions in one directory,
    /// each running Claude, are indistinguishable by directory — and picking one
    /// of them is the wrong answer `#1005` success criterion 1 forbids. Claude
    /// reports the identity itself, through the hook the agent installs, so the
    /// answer is *reported* rather than inferred (see [`crate::binding`]).
    ///
    /// `None` means no binding has been written for this session — Claude has not
    /// started in it yet, the hook has not fired, or the host cannot read the
    /// agent's state directory. It does **not** mean the session has no
    /// conversation: the candidate list is still the answer to that, and a caller
    /// must not read `None` as "nothing here".
    async fn session_claude_binding(&self, session_id: &str) -> Option<Binding>;
}

/// A host that knows nothing — every lookup answers `None`.
///
/// For tests and for a provider built before any host exists. It is deliberately
/// **not** the shape `ClaudeCodeAgentExtension::new` defaults to: a provider
/// that silently cannot resolve any session looks identical to one whose
/// sessions have no conversations, and that is the failure this whole capability
/// is written to avoid.
pub struct NoSessionContext;

#[async_trait]
impl SessionContext for NoSessionContext {
    async fn session_cwd(&self, _session_id: &str) -> Option<String> {
        None
    }

    async fn session_claude_active(&self, _session_id: &str) -> Option<bool> {
        None
    }

    async fn session_claude_binding(&self, _session_id: &str) -> Option<Binding> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_host_that_knows_nothing_says_so_rather_than_guessing() {
        assert_eq!(NoSessionContext.session_cwd("anything").await, None);
        assert_eq!(
            NoSessionContext.session_claude_binding("anything").await,
            None
        );
    }
}
