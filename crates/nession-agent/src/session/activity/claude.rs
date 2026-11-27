//! The Claude Code Session Activity adapter (#3801).
//!
//! This is the **Capability → Session Activity** seam only. Claude's native
//! business state, conversation identity and process binding belong to
//! `nession-claude-code` / #3779 (`ClaudeControl::status`); this adapter maps
//! that verified answer onto `working | idle | unknown` and decides which
//! **Pane** the capability currently owns.
//!
//! ## Ownership is proved, not named
//!
//! A foreground command called `claude` is not working evidence and not
//! ownership evidence. The adapter claims a Pane only when one of these holds:
//!
//! - the status observation bound an interactive Claude PID, and process
//!   discovery places that PID in this Pane;
//! - the status could not bind a PID, but this Pane's process tree contains a
//!   Claude process (mapped to `unknown`, never guessed working);
//! - the status itself is unreadable, but this Pane's foreground command is an
//!   agent CLI (mapped to `unknown`, so Shell cannot claim it as working).
//!
//! With no Claude process the adapter returns `None` and releases the Pane to
//! the generic Shell provider.
//!
//! ## Bounded query cadence
//!
//! `ClaudeControl::status` spawns the official CLI and process discovery reads
//! the Session's membership. Both are cached for [`CACHE_TTL`] per
//! `(Session name, incarnation)`, and a changed foreground reference forces a
//! fresh observation immediately. This is a transient query cache — not a
//! persistent hook-status mirror and not a second Claude state engine.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime};

use async_trait::async_trait;
use nession_claude_code::control::{
    ClaudeActivityState, ClaudeControl, ClaudeObservation, ClaudeProcessState, ClaudeSessionTarget,
    ClaudeStatusObservation,
};
use nession_common::session_activity::{
    ActivityLevel, ActivityState, AttentionState, SessionActivityContext, SessionActivityProvider,
    WorkloadClass,
};

use crate::claude_control::AgentClaudeControl;
use crate::session::process_discovery;
use crate::tmux::manager::SessionManager;

/// How long one query answer is reused across the Panes of a Session.
///
/// Long enough to share one CLI probe with every Pane in a reconcile, short
/// enough that `busy → idle` is visible on the next poll even when the pane's
/// foreground command has not changed.
const CACHE_TTL: Duration = Duration::from_secs(2);
/// Defensive bound on remembered Sessions. A Session that disappears is
/// dropped on the next prune; the map cannot grow with churn between prunes.
const MAX_CACHE_ENTRIES: usize = 512;

/// The Claude Code capability's Activity provider.
pub struct ClaudeActivityProvider {
    agent_id: String,
    tmux: Arc<SessionManager>,
    control: Arc<dyn ClaudeControl>,
    observations: StdMutex<HashMap<String, CachedObservation>>,
    sequence: AtomicU64,
}

#[derive(Clone)]
struct CachedObservation {
    /// The Pane foreground reference this answer was observed under. A change
    /// retires the answer immediately rather than waiting for the TTL.
    foreground: String,
    at: Instant,
    status: ClaudeStatusObservation,
    /// The Pane whose process tree contains the bound Claude PID.
    bound_pane: Option<String>,
    /// Panes whose process tree contains a Claude-named process.
    claude_panes: Vec<String>,
}

impl ClaudeActivityProvider {
    /// The production provider: #3779's Agent-side Claude control.
    pub fn new(agent_id: impl Into<String>, tmux: Arc<SessionManager>) -> Self {
        let agent_id = agent_id.into();
        let control = Arc::new(AgentClaudeControl::new(agent_id.clone(), Arc::clone(&tmux)));
        Self::with_control(agent_id, tmux, control)
    }

    /// A provider over an explicit control seam — the deterministic fixture
    /// used by the runtime Case.
    pub(crate) fn with_control(
        agent_id: impl Into<String>,
        tmux: Arc<SessionManager>,
        control: Arc<dyn ClaudeControl>,
    ) -> Self {
        Self {
            agent_id: agent_id.into(),
            tmux,
            control,
            observations: StdMutex::new(HashMap::new()),
            sequence: AtomicU64::new(0),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, CachedObservation>> {
        self.observations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn cached(&self, key: &str, foreground: &str) -> Option<CachedObservation> {
        let observations = self.lock();
        observations.get(key).and_then(|cached| {
            (cached.at.elapsed() < CACHE_TTL && cached.foreground == foreground)
                .then(|| cached.clone())
        })
    }

    fn store(&self, key: String, observation: CachedObservation) {
        let mut observations = self.lock();
        if observations.len() >= MAX_CACHE_ENTRIES {
            observations.retain(|_, cached| cached.at.elapsed() < CACHE_TTL);
        }
        observations.insert(key, observation);
    }

    /// The conversation a fresh verified observation names for this Session
    /// (#4664 D6 / SC-10).
    ///
    /// The read path's window onto the control path's live self-report: the
    /// same cached observation the Activity projection uses, surfaced so the
    /// conversation list cannot diverge from status on a verified
    /// conversation. Read-only — it never spawns a CLI probe. Freshness is the
    /// cache's own TTL bound; an observation older than that, or one that did
    /// not verify a running Claude, names nothing, and the lifecycle binding
    /// remains the reported evidence.
    pub fn verified_conversation(&self, session_name: &str, instance_id: &str) -> Option<String> {
        let key = format!("{session_name}\0{instance_id}");
        let observations = self.lock();
        let cached = observations.get(&key)?;
        if cached.at.elapsed() >= CACHE_TTL
            || cached.status.observation != ClaudeObservation::Verified
            || cached.status.process != ClaudeProcessState::Running
        {
            return None;
        }
        cached.status.conversation_id.clone()
    }

    async fn observe(
        &self,
        context: &SessionActivityContext,
        foreground: String,
    ) -> CachedObservation {
        let target = ClaudeSessionTarget {
            agent_id: self.agent_id.clone(),
            session_id: format!("{}:{}", self.agent_id, context.session_name),
        };
        let status = self.control.status(&target).await;
        // Discovery runs whenever Claude may be present. A verified process
        // binds a PID to a Pane; after an unreadable status the same Pane
        // membership is what proves the workload belongs to Claude rather than
        // to Shell.
        let (bound_pane, claude_panes) =
            if !matches!(status.process, ClaudeProcessState::NotRunning) {
                match process_discovery::discover_session_processes(
                    &self.tmux.tmux_dep(),
                    &context.session_name,
                )
                .await
                {
                    Ok(snapshot) => {
                        let bound_pane = status.process_id.and_then(|pid| {
                            snapshot
                                .panes
                                .iter()
                                .find(|pane| {
                                    pane.processes.iter().any(|process| process.pid == pid)
                                })
                                .map(|pane| pane.pane_id.clone())
                        });
                        let claude_panes = snapshot
                            .panes
                            .iter()
                            .filter(|pane| pane.processes.iter().any(is_claude_process))
                            .map(|pane| pane.pane_id.clone())
                            .collect();
                        (bound_pane, claude_panes)
                    }
                    Err(_) => (None, Vec::new()),
                }
            } else {
                (None, Vec::new())
            };
        CachedObservation {
            foreground,
            at: Instant::now(),
            status,
            bound_pane,
            claude_panes,
        }
    }
}

#[async_trait]
impl SessionActivityProvider for ClaudeActivityProvider {
    fn id(&self) -> &'static str {
        "claude-code"
    }

    fn class(&self) -> WorkloadClass {
        WorkloadClass::Specialized
    }

    async fn probe(
        &self,
        context: &SessionActivityContext,
    ) -> anyhow::Result<Option<ActivityLevel>> {
        let key = format!("{}\0{}", context.session_name, context.session_instance_id);
        let foreground = context
            .foreground
            .as_ref()
            .map(|foreground| foreground.reference.clone())
            .unwrap_or_default();
        let observation = match self.cached(&key, &foreground) {
            Some(cached) => cached,
            None => {
                let observation = self.observe(context, foreground).await;
                self.store(key, observation.clone());
                observation
            }
        };
        let Some((state, attention)) = classify(context, &observation) else {
            return Ok(None);
        };
        Ok(Some(ActivityLevel {
            state,
            attention,
            workload_ref: observation.status.conversation_id,
            source_generation: self.sequence.fetch_add(1, Ordering::Relaxed) + 1,
            observed_at: SystemTime::now(),
        }))
    }
}

/// Map one verified observation onto this Pane, or release it.
fn classify(
    context: &SessionActivityContext,
    observation: &CachedObservation,
) -> Option<(ActivityState, Option<AttentionState>)> {
    match observation.status.process {
        ClaudeProcessState::NotRunning => None,
        ClaudeProcessState::Running => {
            if let Some(bound) = observation.bound_pane.as_ref() {
                if bound != &context.pane_id {
                    // Another Pane owns the bound Claude process. This one is
                    // not Claude's workload.
                    return None;
                }
                return Some(activity_of(&observation.status));
            }
            if is_claude_pane(context, observation) {
                // Claude exists in this Pane but no PID could be bound: own it
                // as unknown rather than letting Shell report working.
                return Some((ActivityState::Unknown, None));
            }
            if is_claude_foreground(context) {
                return Some((ActivityState::Unknown, None));
            }
            None
        }
        ClaudeProcessState::Unknown => {
            // Status is unreadable. A Claude process in this Pane (or a
            // Claude-named foreground when membership also failed) is enough to
            // own it as unknown; anything else stays with Shell.
            (is_claude_pane(context, observation) || is_claude_foreground(context))
                .then_some((ActivityState::Unknown, None))
        }
    }
}

fn activity_of(status: &ClaudeStatusObservation) -> (ActivityState, Option<AttentionState>) {
    match status.activity {
        ClaudeActivityState::Busy => (ActivityState::Working, None),
        ClaudeActivityState::Waiting => {
            (ActivityState::Working, Some(AttentionState::InputRequired))
        }
        ClaudeActivityState::Idle => (ActivityState::Idle, None),
        ClaudeActivityState::Unknown => (ActivityState::Unknown, None),
    }
}

fn is_claude_pane(context: &SessionActivityContext, observation: &CachedObservation) -> bool {
    observation
        .claude_panes
        .iter()
        .any(|pane| pane == &context.pane_id)
}

fn is_claude_foreground(context: &SessionActivityContext) -> bool {
    context
        .foreground
        .as_ref()
        .and_then(|foreground| foreground.command.as_deref())
        .is_some_and(|command| {
            command.eq_ignore_ascii_case("claude") || command.eq_ignore_ascii_case("claude.exe")
        })
}

fn is_claude_process(
    process: &nession_protocol::contracts::session::v1::DiscoveredProcess,
) -> bool {
    nession_claude_code::process::is_claude_cli_process(&process.executable, &process.command)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nession_claude_code::control::{
        ClaudeObservation, EnterOutcome, EnterRequest, EnterStatus, SubmitOutcome, SubmitRequest,
        SubmitStatus,
    };
    use nession_common::session_activity::ForegroundFacts;

    fn context(pane: &str, command: Option<&str>) -> SessionActivityContext {
        SessionActivityContext {
            session_name: "dev".to_string(),
            session_instance_id: "inc-1".to_string(),
            pane_id: pane.to_string(),
            pane_pid: Some(42),
            foreground: command.map(|command| ForegroundFacts {
                reference: format!("{pane}:{command}"),
                command: Some(command.to_string()),
            }),
            owner_generation: 1,
        }
    }

    fn status(
        process: ClaudeProcessState,
        activity: ClaudeActivityState,
        process_id: Option<u32>,
    ) -> ClaudeStatusObservation {
        ClaudeStatusObservation {
            process,
            process_id,
            activity,
            waiting_for: None,
            conversation_id: Some("conversation-1".to_string()),
            observation: if matches!(activity, ClaudeActivityState::Unknown) {
                ClaudeObservation::Unknown
            } else {
                ClaudeObservation::Verified
            },
            detail: None,
            observed_at: "2026-11-18T00:00:00Z".to_string(),
        }
    }

    fn observation(
        status: ClaudeStatusObservation,
        bound_pane: Option<&str>,
        claude_panes: &[&str],
    ) -> CachedObservation {
        CachedObservation {
            foreground: String::new(),
            at: Instant::now(),
            status,
            bound_pane: bound_pane.map(str::to_string),
            claude_panes: claude_panes
                .iter()
                .map(|pane| (*pane).to_string())
                .collect(),
        }
    }

    #[test]
    fn busy_waiting_and_idle_map_to_the_shared_vocabulary() {
        let busy = observation(
            status(
                ClaudeProcessState::Running,
                ClaudeActivityState::Busy,
                Some(7),
            ),
            Some("%1"),
            &["%1"],
        );
        assert_eq!(
            classify(&context("%1", Some("claude")), &busy),
            Some((ActivityState::Working, None))
        );

        let waiting = observation(
            status(
                ClaudeProcessState::Running,
                ClaudeActivityState::Waiting,
                Some(7),
            ),
            Some("%1"),
            &["%1"],
        );
        assert_eq!(
            classify(&context("%1", Some("claude")), &waiting),
            Some((ActivityState::Working, Some(AttentionState::InputRequired)))
        );

        let idle = observation(
            status(
                ClaudeProcessState::Running,
                ClaudeActivityState::Idle,
                Some(7),
            ),
            Some("%1"),
            &["%1"],
        );
        assert_eq!(
            classify(&context("%1", Some("claude")), &idle),
            Some((ActivityState::Idle, None))
        );
    }

    #[test]
    fn only_the_bound_pane_is_owned_and_absence_releases_it() {
        let bound = observation(
            status(
                ClaudeProcessState::Running,
                ClaudeActivityState::Busy,
                Some(7),
            ),
            Some("%1"),
            &["%1"],
        );
        assert_eq!(
            classify(&context("%2", Some("bash")), &bound),
            None,
            "a Pane that does not contain the bound PID is not Claude's"
        );

        let absent = observation(
            status(
                ClaudeProcessState::NotRunning,
                ClaudeActivityState::Unknown,
                None,
            ),
            None,
            &[],
        );
        assert_eq!(
            classify(&context("%1", Some("claude")), &absent),
            None,
            "no Claude process releases the Pane to Shell"
        );
    }

    #[test]
    fn unbound_or_unsupported_claude_is_unknown_not_working() {
        let running_unbound = observation(
            status(
                ClaudeProcessState::Running,
                ClaudeActivityState::Unknown,
                None,
            ),
            None,
            &["%1"],
        );
        assert_eq!(
            classify(&context("%1", Some("claude")), &running_unbound),
            Some((ActivityState::Unknown, None))
        );

        let unreadable = observation(
            status(
                ClaudeProcessState::Unknown,
                ClaudeActivityState::Unknown,
                None,
            ),
            None,
            &[],
        );
        assert_eq!(
            classify(&context("%1", Some("claude")), &unreadable),
            Some((ActivityState::Unknown, None)),
            "an unreadable Claude status must not be masked by Shell working"
        );
        assert_eq!(
            classify(&context("%1", Some("bash")), &unreadable),
            None,
            "without a Claude foreground or process, the Pane is not Claude's"
        );
    }

    #[test]
    fn the_foreground_name_alone_never_produces_working() {
        // A Claude-named process with a verified idle/busy answer maps to that
        // answer; with nothing verified it can only be unknown.
        let idle = observation(
            status(
                ClaudeProcessState::Running,
                ClaudeActivityState::Idle,
                Some(7),
            ),
            Some("%1"),
            &["%1"],
        );
        assert_eq!(
            classify(&context("%1", Some("claude")), &idle),
            Some((ActivityState::Idle, None))
        );
        let no_evidence = observation(
            status(
                ClaudeProcessState::Unknown,
                ClaudeActivityState::Unknown,
                None,
            ),
            None,
            &[],
        );
        assert_eq!(
            classify(&context("%1", None), &no_evidence),
            None,
            "no foreground and no process evidence is not ownership"
        );
    }

    #[test]
    fn the_capability_is_specialized() {
        let provider = ClaudeActivityProvider::with_control(
            "agent-a",
            Arc::new(SessionManager::new()),
            Arc::new(NoControl),
        );
        assert_eq!(provider.id(), "claude-code");
        assert_eq!(provider.class(), WorkloadClass::Specialized);
    }

    // ---- the verified-identity window (#4664 D6 / SC-10) -------------------

    struct FixedControl(ClaudeStatusObservation);

    #[async_trait]
    impl ClaudeControl for FixedControl {
        async fn status(&self, _target: &ClaudeSessionTarget) -> ClaudeStatusObservation {
            self.0.clone()
        }
        async fn enter(&self, _request: EnterRequest) -> EnterOutcome {
            unimplemented!("the accessor never enters")
        }
        async fn submit(&self, _request: SubmitRequest) -> SubmitOutcome {
            unimplemented!("the accessor never submits")
        }
    }

    #[tokio::test]
    async fn a_fresh_verified_observation_names_its_conversation() {
        let provider = ClaudeActivityProvider::with_control(
            "agent-a",
            Arc::new(SessionManager::new()),
            Arc::new(FixedControl(status(
                ClaudeProcessState::Running,
                ClaudeActivityState::Idle,
                Some(42),
            ))),
        );
        // Populate the cache the way the Activity projection does.
        let _ = provider.probe(&context("p1", Some("claude.exe"))).await;
        assert_eq!(
            provider.verified_conversation("dev", "inc-1").as_deref(),
            Some("conversation-1")
        );
        // Another instance of the same name reads nothing — the cache key is
        // instance-fenced like the binding files.
        assert_eq!(provider.verified_conversation("dev", "inc-2"), None);
    }

    #[tokio::test]
    async fn an_unverified_or_absent_observation_names_nothing() {
        // Unknown activity is not Verified; NotRunning is not a live Claude.
        for fixture in [
            status(
                ClaudeProcessState::Running,
                ClaudeActivityState::Unknown,
                None,
            ),
            status(
                ClaudeProcessState::NotRunning,
                ClaudeActivityState::Unknown,
                None,
            ),
        ] {
            let provider = ClaudeActivityProvider::with_control(
                "agent-a",
                Arc::new(SessionManager::new()),
                Arc::new(FixedControl(fixture)),
            );
            let _ = provider.probe(&context("p1", Some("claude.exe"))).await;
            assert_eq!(provider.verified_conversation("dev", "inc-1"), None);
        }
        // And a provider that never observed answers None rather than guessing.
        let fresh = ClaudeActivityProvider::with_control(
            "agent-a",
            Arc::new(SessionManager::new()),
            Arc::new(NoControl),
        );
        assert_eq!(fresh.verified_conversation("dev", "inc-1"), None);
    }

    struct NoControl;

    #[async_trait]
    impl ClaudeControl for NoControl {
        async fn status(&self, _target: &ClaudeSessionTarget) -> ClaudeStatusObservation {
            status(
                ClaudeProcessState::NotRunning,
                ClaudeActivityState::Unknown,
                None,
            )
        }

        async fn enter(&self, _request: EnterRequest) -> EnterOutcome {
            EnterOutcome {
                conversation_id: None,
                status: EnterStatus::Refused,
                process: ClaudeProcessState::Unknown,
                activity: ClaudeActivityState::Unknown,
                observation: ClaudeObservation::Unknown,
                detail: Some("not used by this fixture".to_string()),
                observed_at: "2026-11-18T00:00:00Z".to_string(),
            }
        }

        async fn submit(&self, _request: SubmitRequest) -> SubmitOutcome {
            SubmitOutcome {
                conversation_id: None,
                status: SubmitStatus::Refused,
                observation: ClaudeObservation::Unknown,
                detail: Some("not used by this fixture".to_string()),
                observed_at: "2026-11-18T00:00:00Z".to_string(),
            }
        }
    }
}

/// Real-tmux runtime proof for #3801 SC-01/SC-02.
///
/// The fixture is a CLI-compatible `claude` script in the Session's PATH: the
/// real `AgentClaudeControl` runs it, the real process discovery binds its PID
/// to the Pane, and the adapter maps busy/waiting/idle, refuses a stale PID,
/// reports a CLI without `agents --json` as unknown and releases the Pane when
/// the process exits. A second Pane proves per-Pane ownership.
#[cfg(test)]
#[cfg(unix)]
mod runtime_tests {
    use super::*;
    use crate::session::activity::contexts_from_tmux;
    use crate::test_support::{install_via_a_child, TestSession};
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use tokio::time::{sleep, timeout};

    fn write_script(dir: &Path, version: &str, supports_agents: bool) -> String {
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).expect("fake bin");
        let state = dir.join("state");
        std::fs::create_dir_all(&state).expect("fake state");
        let script = format!(
            r#"#!/bin/sh
STATE="{state}"
case "$1" in
  --version) echo "{version} (Claude Code)"; exit 0 ;;
  agents)
    if [ "{supports_agents}" != "true" ]; then
      echo "error: unknown command 'agents'" >&2
      exit 1
    fi
    pid=$(cat "$STATE/pid" 2>/dev/null || echo 0)
    status=$(cat "$STATE/status" 2>/dev/null || echo unknown)
    if [ "$status" = "waiting" ]; then
      printf '[{{"kind":"interactive","pid":%s,"sessionId":"conversation-1","cwd":"/tmp","status":"waiting","waitingFor":"input needed"}}]\n' "$pid"
    else
      printf '[{{"kind":"interactive","pid":%s,"sessionId":"conversation-1","cwd":"/tmp","status":"%s"}}]\n' "$pid" "$status"
    fi ;;
  *)
    echo $$ > "$STATE/pid"
    while :; do sleep 0.2; done ;;
esac
"#,
            state = state.display(),
            version = version,
        );
        let path = bin.join("claude");
        install_via_a_child(&path, &script).expect("install the fake claude CLI");
        let mut permissions = std::fs::metadata(&path)
            .expect("fake claude metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).expect("fake claude is executable");
        path.to_string_lossy().into_owned()
    }

    async fn wait_for_claude(manager: &SessionManager, session_name: &str) -> (String, u32) {
        timeout(Duration::from_secs(20), async {
            loop {
                let snapshot = process_discovery::discover_session_processes(
                    &manager.tmux_dep(),
                    session_name,
                )
                .await
                .expect("process discovery answers");
                for pane in &snapshot.panes {
                    for process in &pane.processes {
                        if is_claude_process(process) {
                            return (pane.pane_id.clone(), process.pid);
                        }
                    }
                }
                sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("the fake Claude process appears in the Pane")
    }

    async fn contexts(manager: &SessionManager, session_name: &str) -> Vec<SessionActivityContext> {
        let sessions = manager.list_sessions().await.expect("sessions");
        let panes = manager.list_panes().await.expect("panes");
        contexts_from_tmux(&sessions, &panes)
            .into_iter()
            .filter(|context| context.session_name == session_name)
            .collect()
    }

    async fn probe(
        provider: &ClaudeActivityProvider,
        manager: &SessionManager,
        session_name: &str,
        pane_id: &str,
    ) -> Option<ActivityLevel> {
        let context = contexts(manager, session_name)
            .await
            .into_iter()
            .find(|context| context.pane_id == pane_id)
            .expect("the Pane is observed");
        provider.probe(&context).await.expect("the probe answers")
    }

    async fn wait_for_release(manager: &SessionManager, session_name: &str) {
        timeout(Duration::from_secs(20), async {
            loop {
                let snapshot = process_discovery::discover_session_processes(
                    &manager.tmux_dep(),
                    session_name,
                )
                .await
                .expect("process discovery answers");
                let has_claude = snapshot
                    .panes
                    .iter()
                    .any(|pane| pane.processes.iter().any(is_claude_process));
                if !has_claude {
                    return;
                }
                sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("the fake Claude process exits");
    }

    #[tokio::test]
    async fn a_bound_claude_pane_maps_busy_waiting_idle_and_releases_on_exit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = write_script(dir.path(), "2.1.326", true);
        let manager = Arc::new(SessionManager::new());
        let session = TestSession::new("claude-activity");
        let path = format!(
            "{}:{}",
            dir.path().join("bin").display(),
            std::env::var("PATH").unwrap_or_default()
        );
        manager
            .create_session(
                session.name(),
                80,
                24,
                &dir.path().to_string_lossy(),
                &[("PATH".to_string(), path)],
            )
            .await
            .expect("tmux creates the fixture Session");
        manager
            .tmux_dep()
            .ops()
            .send_keys(session.name(), &script)
            .await
            .expect("the Pane runs the fake claude CLI");

        let (pane_id, pid) = wait_for_claude(&manager, session.name()).await;
        let provider = ClaudeActivityProvider::with_control(
            "agent-a",
            Arc::clone(&manager),
            Arc::new(AgentClaudeControl::new("agent-a", Arc::clone(&manager))),
        );
        let state = dir.path().join("state");

        std::fs::write(state.join("status"), "busy").expect("busy state");
        let level = probe(&provider, &manager, session.name(), &pane_id)
            .await
            .expect("a bound Claude owns the Pane");
        assert_eq!(level.state, ActivityState::Working);
        assert_eq!(level.attention, None);
        assert_eq!(level.workload_ref.as_deref(), Some("conversation-1"));

        std::fs::write(state.join("status"), "idle").expect("idle state");
        sleep(CACHE_TTL + Duration::from_millis(250)).await;
        let level = probe(&provider, &manager, session.name(), &pane_id)
            .await
            .expect("idle is still ownership");
        assert_eq!(level.state, ActivityState::Idle);

        std::fs::write(state.join("status"), "busy").expect("busy again");
        sleep(CACHE_TTL + Duration::from_millis(250)).await;
        assert_eq!(
            probe(&provider, &manager, session.name(), &pane_id)
                .await
                .expect("busy again is ownership")
                .state,
            ActivityState::Working,
            "busy → idle → busy follows the verified status"
        );

        std::fs::write(state.join("status"), "waiting").expect("waiting state");
        sleep(CACHE_TTL + Duration::from_millis(250)).await;
        let level = probe(&provider, &manager, session.name(), &pane_id)
            .await
            .expect("waiting is still ownership");
        assert_eq!(level.state, ActivityState::Working);
        assert_eq!(level.attention, Some(AttentionState::InputRequired));

        std::fs::write(state.join("status"), "idle").expect("idle before split");
        sleep(CACHE_TTL + Duration::from_millis(250)).await;
        let level = probe(&provider, &manager, session.name(), &pane_id)
            .await
            .expect("idle is still ownership");
        assert_eq!(level.state, ActivityState::Idle);

        // A second Pane does not inherit the bound Claude process.
        manager
            .tmux_dep()
            .cmd()
            .output(&["split-window", "-t", session.name(), "-d"])
            .await
            .expect("a second Pane exists");
        sleep(Duration::from_millis(300)).await;
        let other_pane = contexts(&manager, session.name())
            .await
            .into_iter()
            .find(|context| context.pane_id != pane_id)
            .expect("the split Pane is observed")
            .pane_id;
        assert!(
            probe(&provider, &manager, session.name(), &other_pane)
                .await
                .is_none(),
            "a Pane that does not contain the Claude PID is not Claude's"
        );

        // A stale PID cannot be bound; a Claude-named foreground is owned as
        // unknown rather than releasing it to Shell working.
        std::fs::write(state.join("pid"), "999999").expect("stale pid");
        sleep(CACHE_TTL + Duration::from_millis(250)).await;
        let level = probe(&provider, &manager, session.name(), &pane_id)
            .await
            .expect("a Claude foreground with an unbound PID is still Claude's");
        assert_eq!(level.state, ActivityState::Unknown);

        // A CLI without the command is unknown, not idle and not Shell
        // working. Its version is not pre-gated: the refusal itself is the
        // answer the adapter must not turn into a state guess.
        std::fs::write(state.join("pid"), pid.to_string()).expect("restore pid");
        write_script(dir.path(), "2.0.0", false);
        sleep(CACHE_TTL + Duration::from_millis(250)).await;
        let level = probe(&provider, &manager, session.name(), &pane_id)
            .await
            .expect("an unsupported CLI is still the Claude workload");
        assert_eq!(level.state, ActivityState::Unknown);

        // The process exits and the shell regains the Pane: release ownership.
        manager
            .tmux_dep()
            .cmd()
            .output(&["send-keys", "-t", session.name(), "C-c"])
            .await
            .expect("SIGINT reaches the fake CLI");
        wait_for_release(&manager, session.name()).await;
        sleep(CACHE_TTL + Duration::from_millis(250)).await;
        assert!(
            probe(&provider, &manager, session.name(), &pane_id)
                .await
                .is_none(),
            "with no Claude process the Pane is released to the Shell provider"
        );
    }
}
