//! The Agent's Claude control backend (`#3779`).
//!
//! The Agent is the execution authority for a Session: it owns the tmux
//! Session, the read-only process membership and the Session's cwd/environment.
//! This implementation binds those to the Tools' typed contracts:
//!
//! * Claude's own answer comes from the verified on-demand
//!   `claude agents --json` probe ([`nession_claude_code::agent_view`]), run in
//!   the Session's cwd with its observed home/config environment;
//! * a reported PID is accepted only when the Session's process discovery
//!   already lists it. Cwd, process name and "the newest conversation" are not
//!   identity;
//! * the CLI is never asked when the Session has no Claude process — absence is
//!   an observed fact, not an unavailable status.

use std::collections::HashSet;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use nession_claude_code::agent_view::AgentViewObservation;
use nession_claude_code::agent_view::{
    probe_agent_view, AgentSessionKind, ClaudeActivity, ClaudeCliRunner, CliFailure, CliOutput,
    ObservedAgentSession,
};
use nession_claude_code::control::{
    ClaudeActivityState, ClaudeControl, ClaudeObservation, ClaudeProcessState, ClaudeSessionTarget,
    ClaudeStatusObservation, EnterMode, EnterOutcome, EnterRequest, EnterStatus, SubmitOutcome,
    SubmitRequest, SubmitStatus,
};
use nession_claude_code::process::is_claude_cli_process;

use crate::tmux::manager::SessionManager;

/// Bound on one CLI observation. The command is a local read; a hung process is
/// an `unknown`, never a false idle.
const CLI_TIMEOUT: Duration = Duration::from_secs(10);

/// The Agent-side control backend.
pub struct AgentClaudeControl {
    agent_id: String,
    tmux: Arc<SessionManager>,
    /// Serializes enter/submit so two calls cannot be concurrent writers to one
    /// transcript. Status observation never takes it.
    write_lock: tokio::sync::Mutex<()>,
}

impl AgentClaudeControl {
    /// Build the backend for one Agent.
    pub fn new(agent_id: impl Into<String>, tmux: Arc<SessionManager>) -> Self {
        Self {
            agent_id: agent_id.into(),
            tmux,
            write_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// The Session name this target names on this Agent.
    fn session_name<'a>(&self, target: &'a ClaudeSessionTarget) -> Option<&'a str> {
        target
            .session_id
            .strip_prefix(&format!("{}:", self.agent_id))
    }

    async fn observe(&self, session_name: &str) -> ClaudeStatusObservation {
        let observed_at = Utc::now().to_rfc3339();
        let cwd = match self.tmux.get_session_cwd(session_name).await {
            Ok(cwd) => cwd,
            Err(error) => {
                return ClaudeStatusObservation::unavailable(
                    ClaudeObservation::Unknown,
                    format!("Nession Session '{session_name}' is not observable: {error:#}"),
                    observed_at,
                )
            }
        };
        let tmux = self.tmux.tmux_dep();
        let processes = match crate::session::process_discovery::discover_session_processes(
            &tmux,
            session_name,
        )
        .await
        {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return ClaudeStatusObservation::unavailable(
                    ClaudeObservation::Unknown,
                    format!("process membership is unavailable: {error:#}"),
                    observed_at,
                )
            }
        };
        let members: HashSet<u32> = processes
            .panes
            .iter()
            .flat_map(|pane| pane.processes.iter())
            .map(|process| process.pid)
            .collect();
        let has_claude = processes
            .panes
            .iter()
            .flat_map(|pane| pane.processes.iter())
            .any(|process| is_claude_cli_process(&process.executable, &process.command));
        if !has_claude {
            return ClaudeStatusObservation::not_running(observed_at);
        }

        let runner = SessionCliRunner {
            cwd,
            home: self.session_env(session_name, "HOME").await,
            config_dir: self.session_env(session_name, "CLAUDE_CONFIG_DIR").await,
            path: self.session_env(session_name, "PATH").await,
        };
        match probe_agent_view(&runner).await {
            AgentViewObservation::Supported { sessions, .. } => {
                match bound_process(&sessions, &members) {
                    Some(session) => verified(session, observed_at),
                    None => ClaudeStatusObservation::unavailable(
                        ClaudeObservation::Unknown,
                        "Claude is running in this Session but Agent view did not report a \
                         process belonging to it; activity is unknown",
                        observed_at,
                    ),
                }
            }
            AgentViewObservation::Absent => ClaudeStatusObservation::unavailable(
                ClaudeObservation::Absent,
                "a Claude process is in this Session, but no `claude` executable was found in \
                 its environment",
                observed_at,
            ),
            AgentViewObservation::Unsupported { reason } => ClaudeStatusObservation::unavailable(
                ClaudeObservation::Unsupported,
                reason,
                observed_at,
            ),
            AgentViewObservation::CannotObserve { reason } => ClaudeStatusObservation::unavailable(
                ClaudeObservation::CannotObserve,
                reason,
                observed_at,
            ),
        }
    }

    async fn session_env(&self, session_name: &str, key: &str) -> Option<String> {
        self.tmux
            .get_session_env(session_name, key)
            .await
            .ok()
            .flatten()
    }

    /// Send one literal line into the Session's pane.
    async fn send_line(&self, session_name: &str, line: &str) -> anyhow::Result<()> {
        self.tmux
            .tmux_dep()
            .ops()
            .send_literal_line(session_name, line)
            .await
    }

    /// Observe until `predicate` holds, or return the last observation after a
    /// bounded wait. The wait is a real verification window: a command that
    /// Claude has not yet reflected is reported as pending, never assumed.
    async fn poll<F>(&self, session_name: &str, predicate: F) -> ClaudeStatusObservation
    where
        F: Fn(&ClaudeStatusObservation) -> bool,
    {
        let mut last = self.observe(session_name).await;
        for _ in 0..8 {
            if predicate(&last) {
                return last;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            last = self.observe(session_name).await;
        }
        last
    }
}

#[async_trait]
impl ClaudeControl for AgentClaudeControl {
    async fn status(&self, target: &ClaudeSessionTarget) -> ClaudeStatusObservation {
        if target.agent_id != self.agent_id {
            return ClaudeStatusObservation::unavailable(
                ClaudeObservation::Unknown,
                format!(
                    "this Agent is '{}', not '{}'",
                    self.agent_id, target.agent_id
                ),
                Utc::now().to_rfc3339(),
            );
        }
        let Some(session_name) = self.session_name(target) else {
            return ClaudeStatusObservation::unavailable(
                ClaudeObservation::Unknown,
                "`session_id` does not name a Session on this Agent",
                Utc::now().to_rfc3339(),
            );
        };
        self.observe(session_name).await
    }

    async fn enter(&self, request: EnterRequest) -> EnterOutcome {
        let refused = |detail: String| EnterOutcome {
            conversation_id: None,
            status: EnterStatus::Refused,
            process: ClaudeProcessState::Unknown,
            activity: ClaudeActivityState::Unknown,
            observation: ClaudeObservation::Unknown,
            detail: Some(detail),
            observed_at: Utc::now().to_rfc3339(),
        };
        if request.target.agent_id != self.agent_id {
            return refused(format!(
                "this Agent is '{}', not '{}'",
                self.agent_id, request.target.agent_id
            ));
        }
        let Some(session_name) = self.session_name(&request.target) else {
            return refused("`session_id` does not name a Session on this Agent".to_string());
        };
        let _guard = self.write_lock.lock().await;
        let before = self.observe(session_name).await;
        match before.process {
            ClaudeProcessState::NotRunning => {
                let (command, expected) = match request.mode {
                    EnterMode::New => {
                        let conversation = uuid::Uuid::new_v4().to_string();
                        (
                            format!("claude --session-id {conversation}"),
                            Some(conversation),
                        )
                    }
                    EnterMode::Resume => {
                        let Some(conversation) = request.conversation_id.clone() else {
                            return refused("`conversation_id` is required for resume".to_string());
                        };
                        (
                            format!("claude --resume {conversation}"),
                            Some(conversation),
                        )
                    }
                };
                if let Err(error) = self.send_line(session_name, &command).await {
                    return EnterOutcome {
                        conversation_id: expected,
                        status: EnterStatus::Pending,
                        process: before.process,
                        activity: before.activity,
                        observation: ClaudeObservation::Unknown,
                        detail: Some(format!(
                            "the launch command was not confirmed; inspect the Session before \
                             retrying: {error:#}"
                        )),
                        observed_at: Utc::now().to_rfc3339(),
                    };
                }
                let after = self
                    .poll(session_name, |status| {
                        status.observation == ClaudeObservation::Verified
                            && status.process == ClaudeProcessState::Running
                            && expected
                                .as_deref()
                                .is_none_or(|id| status.conversation_id.as_deref() == Some(id))
                    })
                    .await;
                let entered = after.observation == ClaudeObservation::Verified
                    && after.process == ClaudeProcessState::Running
                    && expected
                        .as_deref()
                        .is_none_or(|id| after.conversation_id.as_deref() == Some(id));
                EnterOutcome {
                    conversation_id: expected.or_else(|| after.conversation_id.clone()),
                    status: if entered {
                        EnterStatus::Entered
                    } else {
                        EnterStatus::Pending
                    },
                    process: after.process,
                    activity: after.activity,
                    observation: after.observation,
                    detail: if entered {
                        None
                    } else {
                        Some(
                            "the launch was sent but the resulting conversation is not yet \
                             verified; read status before relying on it"
                                .to_string(),
                        )
                    },
                    observed_at: after.observed_at,
                }
            }
            ClaudeProcessState::Running => {
                if before.observation != ClaudeObservation::Verified
                    || before.activity != ClaudeActivityState::Idle
                {
                    return EnterOutcome {
                        conversation_id: before.conversation_id,
                        status: EnterStatus::Refused,
                        process: before.process,
                        activity: before.activity,
                        observation: before.observation,
                        detail: Some(
                            "Claude is not verifiably idle; refusing to redirect it or create a \
                             concurrent transcript writer"
                                .to_string(),
                        ),
                        observed_at: before.observed_at,
                    };
                }
                let previous = before.conversation_id.clone();
                let (command, expected) = match request.mode {
                    EnterMode::New => ("/clear".to_string(), None),
                    EnterMode::Resume => {
                        let Some(conversation) = request.conversation_id.clone() else {
                            return refused("`conversation_id` is required for resume".to_string());
                        };
                        (format!("/resume {conversation}"), Some(conversation))
                    }
                };
                if let Err(error) = self.send_line(session_name, &command).await {
                    return EnterOutcome {
                        conversation_id: previous,
                        status: EnterStatus::Pending,
                        process: before.process,
                        activity: before.activity,
                        observation: ClaudeObservation::Unknown,
                        detail: Some(format!(
                            "the in-process command was not confirmed; inspect the Session \
                             before retrying: {error:#}"
                        )),
                        observed_at: Utc::now().to_rfc3339(),
                    };
                }
                let after = self
                    .poll(session_name, |status| {
                        status.observation == ClaudeObservation::Verified
                            && match expected.as_deref() {
                                Some(id) => status.conversation_id.as_deref() == Some(id),
                                None => {
                                    status.conversation_id.is_some()
                                        && status.conversation_id != previous
                                }
                            }
                    })
                    .await;
                let entered = after.observation == ClaudeObservation::Verified
                    && match expected.as_deref() {
                        Some(id) => after.conversation_id.as_deref() == Some(id),
                        None => {
                            after.conversation_id.is_some() && after.conversation_id != previous
                        }
                    };
                EnterOutcome {
                    conversation_id: after.conversation_id.clone(),
                    status: if entered {
                        EnterStatus::Entered
                    } else {
                        EnterStatus::Pending
                    },
                    process: after.process,
                    activity: after.activity,
                    observation: after.observation,
                    detail: if entered {
                        None
                    } else {
                        Some(
                            "the in-process command was sent but the resulting exact \
                             conversation id is not yet verified"
                                .to_string(),
                        )
                    },
                    observed_at: after.observed_at,
                }
            }
            ClaudeProcessState::Unknown => EnterOutcome {
                conversation_id: None,
                status: EnterStatus::Refused,
                process: before.process,
                activity: before.activity,
                observation: before.observation,
                detail: Some(
                    "the Claude process state is unknown; refusing to send input".to_string(),
                ),
                observed_at: before.observed_at,
            },
        }
    }

    async fn submit(&self, request: SubmitRequest) -> SubmitOutcome {
        let refused = |status: &ClaudeStatusObservation, detail: String| SubmitOutcome {
            conversation_id: status.conversation_id.clone(),
            status: SubmitStatus::Refused,
            observation: status.observation,
            detail: Some(detail),
            observed_at: status.observed_at.clone(),
        };
        if request.target.agent_id != self.agent_id {
            return SubmitOutcome {
                conversation_id: None,
                status: SubmitStatus::Refused,
                observation: ClaudeObservation::Unknown,
                detail: Some(format!(
                    "this Agent is '{}', not '{}'",
                    self.agent_id, request.target.agent_id
                )),
                observed_at: Utc::now().to_rfc3339(),
            };
        }
        let Some(session_name) = self.session_name(&request.target) else {
            return SubmitOutcome {
                conversation_id: None,
                status: SubmitStatus::Refused,
                observation: ClaudeObservation::Unknown,
                detail: Some("`session_id` does not name a Session on this Agent".to_string()),
                observed_at: Utc::now().to_rfc3339(),
            };
        };
        let _guard = self.write_lock.lock().await;
        let status = self.observe(session_name).await;
        if status.observation != ClaudeObservation::Verified
            || status.process != ClaudeProcessState::Running
        {
            return refused(
                &status,
                "Claude is not verifiably running in this Session; refusing to submit".to_string(),
            );
        }
        if status.activity != ClaudeActivityState::Idle {
            return refused(
                &status,
                "Claude is not idle (busy, waiting or unknown); refusing to submit".to_string(),
            );
        }
        if status.conversation_id.as_deref() != Some(request.conversation_id.as_str()) {
            return refused(
                &status,
                "the verified conversation does not match `conversation_id`; re-read status and \
                 retry against the actual conversation"
                    .to_string(),
            );
        }
        match self.send_line(session_name, &request.prompt).await {
            Ok(()) => SubmitOutcome {
                conversation_id: status.conversation_id,
                status: SubmitStatus::InputSent,
                observation: ClaudeObservation::Verified,
                detail: None,
                observed_at: Utc::now().to_rfc3339(),
            },
            Err(error) => SubmitOutcome {
                conversation_id: status.conversation_id,
                status: SubmitStatus::Unknown,
                observation: status.observation,
                detail: Some(format!(
                    "the input may or may not have reached Claude; read the conversation back \
                     before retrying: {error:#}"
                )),
                observed_at: Utc::now().to_rfc3339(),
            },
        }
    }
}

/// The first interactive record whose PID is proved to be in this Session.
fn bound_process<'a>(
    sessions: &'a [ObservedAgentSession],
    members: &HashSet<u32>,
) -> Option<&'a ObservedAgentSession> {
    sessions.iter().find(|session| {
        session.kind == AgentSessionKind::Interactive
            && session.pid.is_some_and(|pid| members.contains(&pid))
    })
}

fn verified(session: &ObservedAgentSession, observed_at: String) -> ClaudeStatusObservation {
    let (activity, waiting_for) = match &session.activity {
        Some(ClaudeActivity::Busy) => (ClaudeActivityState::Busy, None),
        Some(ClaudeActivity::Waiting { waiting_for }) => {
            (ClaudeActivityState::Waiting, waiting_for.clone())
        }
        Some(ClaudeActivity::Idle) => (ClaudeActivityState::Idle, None),
        Some(ClaudeActivity::Unknown(_)) | None => (ClaudeActivityState::Unknown, None),
    };
    let observation = if matches!(activity, ClaudeActivityState::Unknown) {
        ClaudeObservation::Unknown
    } else {
        ClaudeObservation::Verified
    };
    ClaudeStatusObservation {
        process: ClaudeProcessState::Running,
        process_id: session.pid,
        activity,
        waiting_for,
        conversation_id: session.session_id.clone(),
        observation,
        detail: match &session.activity {
            Some(ClaudeActivity::Unknown(reported)) => {
                Some(format!("Claude reported an unknown activity '{reported}'"))
            }
            _ => None,
        },
        observed_at,
    }
}

/// Runs the official CLI in one Session's cwd/environment.
struct SessionCliRunner {
    cwd: String,
    home: Option<String>,
    config_dir: Option<String>,
    path: Option<String>,
}

#[async_trait]
impl ClaudeCliRunner for SessionCliRunner {
    async fn run(&self, args: &[&str]) -> Result<CliOutput, CliFailure> {
        let mut command = tokio::process::Command::new("claude");
        command
            .args(args)
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(home) = &self.home {
            command.env("HOME", home);
        }
        if let Some(config_dir) = &self.config_dir {
            command.env("CLAUDE_CONFIG_DIR", config_dir);
        }
        if let Some(path) = &self.path {
            command.env("PATH", path);
        }
        match tokio::time::timeout(CLI_TIMEOUT, command.output()).await {
            Ok(Ok(output)) => Ok(CliOutput {
                success: output.status.success(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            }),
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(CliFailure::NotFound)
            }
            Ok(Err(error)) => Err(CliFailure::Failed(error.to_string())),
            Err(_) => Err(CliFailure::Failed(format!(
                "timed out after {}s",
                CLI_TIMEOUT.as_secs()
            ))),
        }
    }
}
