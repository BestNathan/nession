//! Creation-time Claude Workspace Trust adapter (#4073).
//!
//! The trust decision, key resolution and configuration writer belong to
//! [`nession_claude_code::workspace_trust`]. This module only adapts that
//! capability's answer into the Session-create reply:
//!
//! * a create that succeeds still succeeds when trust cannot be prepared — the
//!   warning says so, and non-Claude consumers are unaffected;
//! * `claude.enter` re-resolves the same live facts immediately before launch
//!   and refuses there when preparation still fails, so the warning is never the
//!   only line of defence.
//!
//! The caller supplies the host's live [`SessionContext`]; it must run after the
//! Session's environment binding exists, because the Claude config identity is
//! observed from that environment rather than from the Agent daemon.

use nession_claude_code::session_context::SessionContext;
use std::sync::Arc;

use crate::session_created::SessionCreatedHook;

/// The production post-create hook: prepare Claude Workspace Trust.
///
/// Composed once by `runtime.rs` and shared by both Session-create entrypoints.
pub struct ClaudeWorkspaceTrustHook {
    context: Arc<dyn SessionContext>,
}

impl ClaudeWorkspaceTrustHook {
    /// Bind the hook to the Agent host's live Session view.
    pub fn new(context: Arc<dyn SessionContext>) -> Self {
        Self { context }
    }
}

#[async_trait::async_trait]
impl SessionCreatedHook for ClaudeWorkspaceTrustHook {
    async fn session_created(&self, agent_id: &str, session_name: &str) -> Option<String> {
        prepare_after_create(self.context.as_ref(), agent_id, session_name).await
    }
}

/// Prepare Workspace Trust for one Session that was just created.
///
/// Returns the warning to attach to the create reply, or `None` when the
/// acceptance is in place (or already was).
pub async fn prepare_after_create(
    context: &dyn SessionContext,
    agent_id: &str,
    session_name: &str,
) -> Option<String> {
    match nession_claude_code::workspace_trust::prepare_session(
        context,
        &format!("{agent_id}:{session_name}"),
    )
    .await
    {
        Ok(_) => None,
        Err(error) => Some(format!(
            "Claude Workspace Trust was not prepared for this Session; claude.enter re-checks \
             before launch and refuses if it still cannot: {error}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nession_claude_code::session_context::SessionClaudeConfig;
    use std::path::PathBuf;

    struct FixedContext {
        cwd: Option<String>,
        config: Option<SessionClaudeConfig>,
    }

    #[async_trait::async_trait]
    impl SessionContext for FixedContext {
        async fn session_cwd(&self, _session_id: &str) -> Option<String> {
            self.cwd.clone()
        }

        async fn session_claude_config(&self, _session_id: &str) -> Option<SessionClaudeConfig> {
            self.config.clone()
        }

        async fn session_claude_active(&self, _session_id: &str) -> Option<bool> {
            Some(false)
        }

        async fn session_claude_binding(
            &self,
            _session_id: &str,
        ) -> Option<nession_claude_code::binding::Binding> {
            None
        }
    }

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        std::fs::create_dir_all(&home).expect("home");
        let project = temp.path().join("project");
        std::fs::create_dir_all(project.join(".git")).expect("git");
        (temp, home, project)
    }

    fn context(project: &std::path::Path, home: &std::path::Path) -> FixedContext {
        FixedContext {
            cwd: Some(project.to_string_lossy().into_owned()),
            config: Some(SessionClaudeConfig {
                home: Some(home.to_string_lossy().into_owned()),
                ..SessionClaudeConfig::default()
            }),
        }
    }

    #[tokio::test]
    async fn a_prepared_session_contributes_no_warning() {
        let (_temp, home, project) = fixture();
        let warning = prepare_after_create(&context(&project, &home), "agent-a", "dev").await;
        assert!(warning.is_none(), "{warning:?}");
        let document: serde_json::Value =
            serde_json::from_slice(&std::fs::read(home.join(".claude.json")).expect("state file"))
                .expect("valid JSON");
        let key = std::fs::canonicalize(&project)
            .expect("canonical")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            document["projects"][key]["hasTrustDialogAccepted"],
            serde_json::Value::Bool(true)
        );
    }

    #[tokio::test]
    async fn an_unobservable_session_becomes_a_create_warning_not_a_failure() {
        let (_temp, _home, _project) = fixture();
        let warning = prepare_after_create(
            &FixedContext {
                cwd: None,
                config: Some(SessionClaudeConfig::default()),
            },
            "agent-a",
            "dev",
        )
        .await
        .expect("a warning");
        assert!(warning.contains("Workspace Trust"), "{warning}");
        assert!(warning.contains("claude.enter re-checks"), "{warning}");
    }
}
