//! The post-create Session preparation seam (`#4073`).
//!
//! The Agent core owns Session creation. A capability that needs to prepare
//! node-local state for a Session that just came into existence — today the
//! Claude Code Workspace Trust capability — implements this one hook instead of
//! the generic Session owner learning any upstream-specific rule.
//!
//! ## Why it is injected instead of always present
//!
//! The hook performs real side effects outside Nession's own state (for
//! Claude, a write to the Session user's `.claude.json`). A test harness that
//! builds an `AgentServer` directly must not silently write the developer's
//! Claude configuration, so only `runtime.rs` composes the production hook;
//! a test that wants to prove the invocation supplies its own recorder.
//!
//! A hook never fails or rolls back a create. It returns a warning for the
//! create reply when preparation could not be completed, and `None` when there
//! is nothing to say. The capability's own enter-time check remains the
//! fail-closed boundary.

use std::sync::Arc;

use async_trait::async_trait;

/// A preparation hook invoked after a Session and its environment binding exist.
#[async_trait]
pub trait SessionCreatedHook: Send + Sync {
    /// Prepare state for `session_name` on `agent_id`.
    ///
    /// Returning `Some(warning)` appends the warning to the create reply; the
    /// Session itself is already created and remains successful.
    async fn session_created(&self, agent_id: &str, session_name: &str) -> Option<String>;
}

/// The hook both Agent entrypoints carry.
///
/// One value is composed by the runtime and shared by the P2P listener and the
/// central-server connection, so a direct and a Server-relayed create prepare
/// the Session identically.
pub type SharedSessionCreatedHook = Arc<dyn SessionCreatedHook>;
