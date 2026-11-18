//! Session Activity ownership (#3800).
//!
//! The vocabulary and provider contract live in
//! [`nession_common::session_activity`] so a capability crate can implement a
//! provider without depending on this Agent. This module owns the one
//! [`SessionActivityCoordinator`]: provider ownership, Pane aggregation,
//! generation fencing and the Session snapshot.
//!
//! Activity is a fourth, independent Session dimension. It is not tmux
//! lifecycle, Agent connectivity or client attachment, and nothing here may
//! write to those projections.
//!
//! ```text
//! capability provider(s)          Agent (this module)           consumers
//!   probe / report ──────────────> Coordinator ── snapshot ──> SessionWatcher
//!                                  ownership + aggregation      Server/Web (#3804)
//! ```

pub mod coordinator;
pub mod shell;

use std::collections::BTreeMap;

use nession_tmux::ops::PaneSummary;

pub use coordinator::{
    ActivityCompositionError, ActivityReporterHandle, SessionActivityCoordinator,
};
pub use nession_common::session_activity::{
    ActivityLevel, ActivityObservation, ActivityReporter, ActivityState, AttentionState,
    ForegroundFacts, PaneActivitySnapshot, ReportOutcome, SessionActivityContext,
    SessionActivityProvider, SessionActivitySnapshot, WorkloadClass,
};
pub use shell::ShellActivityProvider;

use crate::tmux::manager::SessionInfo;

/// Build the coordinator's complete Pane inventory from one successful tmux
/// enumeration.
///
/// A Session without a durable `@nession_instance_id` is skipped: its activity
/// cannot be fenced against a same-named recreation, so reporting it would be
/// inventing identity. The same applies to a Pane whose Session is missing from
/// `sessions` — tmux's two listings disagreeing is not evidence of a Session.
///
/// The ordering is stable (`Session name`, `Pane id`) so a reconcile's probe
/// order cannot depend on tmux's row order, and linked-Window membership rows
/// are collapsed to one Pane per Session.
pub fn contexts_from_tmux(
    sessions: &[SessionInfo],
    panes: &[PaneSummary],
) -> Vec<SessionActivityContext> {
    let sessions: BTreeMap<&str, &SessionInfo> = sessions
        .iter()
        .map(|session| (session.name.as_str(), session))
        .collect();
    let mut contexts: BTreeMap<(String, String), SessionActivityContext> = BTreeMap::new();
    for pane in panes {
        let Some(session) = sessions.get(pane.session_name.as_str()) else {
            continue;
        };
        let Some(instance_id) = session.instance_id.as_ref() else {
            continue;
        };
        let foreground = pane
            .pane_current_command
            .as_ref()
            .map(|command| ForegroundFacts {
                reference: format!("{}:{}", pane.pane_id, command),
                command: Some(command.clone()),
            });
        contexts.insert(
            (pane.session_name.clone(), pane.pane_id.clone()),
            SessionActivityContext {
                session_name: pane.session_name.clone(),
                session_instance_id: instance_id.clone(),
                pane_id: pane.pane_id.clone(),
                pane_pid: pane.pane_pid,
                foreground,
                owner_generation: 0,
            },
        );
    }
    contexts.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(name: &str, instance_id: Option<&str>) -> SessionInfo {
        SessionInfo {
            name: name.to_string(),
            created_at: 1,
            window_count: 1,
            attached_clients: 0,
            width: 80,
            height: 24,
            foreground_command: Some("bash".to_string()),
            working_dir: Some("/tmp".to_string()),
            instance_id: instance_id.map(str::to_string),
        }
    }

    fn pane(session_name: &str, pane_id: &str, command: Option<&str>) -> PaneSummary {
        PaneSummary {
            session_id: "$1".to_string(),
            session_name: session_name.to_string(),
            window_id: "@1".to_string(),
            window_index: 1,
            window_name: "w".to_string(),
            pane_id: pane_id.to_string(),
            pane_index: 0,
            pane_pid: Some(42),
            pane_tty: Some("/dev/pts/1".to_string()),
            window_linked: false,
            window_active: true,
            pane_active: true,
            pane_current_command: command.map(str::to_string),
        }
    }

    #[test]
    fn a_session_without_a_durable_instance_is_not_observed() {
        let sessions = [session("legacy", None), session("fenced", Some("inc-1"))];
        let panes = [
            pane("legacy", "%1", Some("bash")),
            pane("fenced", "%2", Some("cargo")),
        ];

        let contexts = contexts_from_tmux(&sessions, &panes);
        assert_eq!(contexts.len(), 1);
        assert_eq!(contexts[0].session_name, "fenced");
        assert_eq!(contexts[0].session_instance_id, "inc-1");
    }

    #[test]
    fn a_linked_window_membership_collapses_to_one_pane_per_session() {
        let sessions = [session("alpha", Some("a")), session("beta", Some("b"))];
        let panes = [
            pane("alpha", "%1", Some("bash")),
            pane("beta", "%1", Some("bash")),
        ];

        let contexts = contexts_from_tmux(&sessions, &panes);
        assert_eq!(
            contexts.len(),
            2,
            "each Session observes its own membership"
        );
        assert!(contexts.iter().all(|context| context.pane_id == "%1"));
    }

    #[test]
    fn the_panes_own_foreground_command_names_the_workload() {
        let sessions = [session("dev", Some("inc-1"))];
        let panes = [
            pane("dev", "%2", Some("sleep")),
            pane("dev", "%1", Some("bash")),
        ];

        let contexts = contexts_from_tmux(&sessions, &panes);
        let commands: Vec<_> = contexts
            .iter()
            .map(|context| {
                context
                    .foreground
                    .as_ref()
                    .and_then(|foreground| foreground.command.as_deref())
            })
            .collect();
        assert_eq!(commands, [Some("bash"), Some("sleep")]);
        assert_eq!(
            contexts[1]
                .foreground
                .as_ref()
                .map(|foreground| foreground.reference.as_str()),
            Some("%2:sleep"),
            "the reference is Pane-scoped, so two Panes never share one workload"
        );
    }

    #[test]
    fn a_pane_without_a_reported_command_has_no_foreground_claim() {
        let sessions = [session("dev", Some("inc-1"))];
        let panes = [pane("dev", "%1", None)];

        let contexts = contexts_from_tmux(&sessions, &panes);
        assert_eq!(contexts.len(), 1);
        assert_eq!(contexts[0].foreground, None);
    }
}

/// Real-tmux runtime proof for #3800 SC-03.
///
/// A `--lib` test rather than an integration-test binary: the Acceptance Case
/// runtime can run real-tmux library tests with a private socket, while a
/// nested integration binary has hung there before. Quality still runs the
/// surrounding integration suite.
#[cfg(all(test, unix))]
mod runtime_tests {
    use std::sync::Arc;
    use std::time::{Duration, SystemTime};

    use super::*;
    use crate::test_support::TestSession;
    use crate::tmux::manager::SessionManager;
    use crate::tmux::pty::PtySession;
    use tokio::time::timeout;

    struct WorkingProvider;

    #[async_trait::async_trait]
    impl SessionActivityProvider for WorkingProvider {
        fn id(&self) -> &'static str {
            "fixture-shell"
        }

        fn class(&self) -> WorkloadClass {
            WorkloadClass::GenericShell
        }

        async fn probe(
            &self,
            _context: &SessionActivityContext,
        ) -> anyhow::Result<Option<ActivityLevel>> {
            Ok(Some(ActivityLevel {
                state: ActivityState::Working,
                attention: None,
                workload_ref: Some("fixture-work".to_string()),
                source_generation: 1,
                observed_at: SystemTime::now(),
            }))
        }
    }

    struct FailingSpecializedProvider;

    #[async_trait::async_trait]
    impl SessionActivityProvider for FailingSpecializedProvider {
        fn id(&self) -> &'static str {
            "fixture-specialized"
        }

        fn class(&self) -> WorkloadClass {
            WorkloadClass::Specialized
        }

        async fn probe(
            &self,
            _context: &SessionActivityContext,
        ) -> anyhow::Result<Option<ActivityLevel>> {
            anyhow::bail!("the fixture cannot determine its business state")
        }
    }

    async fn inventory(manager: &SessionManager) -> anyhow::Result<Vec<SessionActivityContext>> {
        let sessions = manager.list_sessions().await?;
        let panes = manager.list_panes().await?;
        Ok(contexts_from_tmux(&sessions, &panes))
    }

    #[tokio::test]
    async fn a_real_pane_keeps_its_terminal_while_activity_reconciles() -> anyhow::Result<()> {
        let manager = SessionManager::new();
        let session = TestSession::new("activity");
        manager
            .create_session(session.name(), 80, 24, "/tmp", &[])
            .await?;

        let (mut pty, mut output) =
            PtySession::attach(&manager.tmux_dep(), session.name(), 80, 24)?;

        let activity =
            SessionActivityCoordinator::new("test-agent", vec![Arc::new(WorkingProvider)])
                .expect("one provider composes");
        let contexts = inventory(&manager).await?;
        let snapshot = activity
            .reconcile(&contexts)
            .await
            .into_iter()
            .find(|snapshot| snapshot.session_name == session.name())
            .expect("the fixture Session is observed");
        assert_eq!(snapshot.state, ActivityState::Working);
        assert_eq!(snapshot.panes.len(), 1);
        assert!(snapshot.panes[0].pane_id.starts_with('%'));

        // Input still reaches the real shell while Activity holds a level.
        pty.write(b"printf 'ACTIVITY-MARK\\n'\n")?;
        let mut seen = Vec::new();
        let echoed = timeout(Duration::from_secs(15), async {
            while let Some(chunk) = output.recv().await {
                seen.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&seen).contains("ACTIVITY-MARK") {
                    return true;
                }
            }
            false
        })
        .await
        .expect("the terminal answers before the deadline");
        assert!(echoed, "the real shell echoed the marker");

        pty.resize(100, 30)?;
        assert_eq!(pty.viewport(), (100, 30));

        // A probe that cannot establish ownership must not invent idle or
        // working, and must not be masked by the generic provider.
        let unknown = SessionActivityCoordinator::new(
            "test-agent",
            vec![
                Arc::new(FailingSpecializedProvider),
                Arc::new(WorkingProvider),
            ],
        )
        .expect("distinct capabilities compose");
        let snapshot = unknown.reconcile(&contexts).await;
        let fixture = snapshot
            .iter()
            .find(|snapshot| snapshot.session_name == session.name())
            .expect("the fixture Session is still observed");
        assert_eq!(fixture.state, ActivityState::Unknown);
        assert_eq!(fixture.panes[0].owner, None);

        // Ending the Session retires its Activity with the same verified
        // enumeration: no stale `working` outlives the Pane.
        manager.kill_session(session.name()).await?;
        activity.reconcile(&inventory(&manager).await?).await;
        assert!(
            activity.snapshot(session.name()).is_none(),
            "a Session absent from the verified inventory has no projected activity"
        );
        Ok(())
    }
}
