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
use nession_claude_code::composer::{observe_composer, ComposerObservation};
use nession_claude_code::control::{
    ClaudeActivityState, ClaudeControl, ClaudeObservation, ClaudeProcessState, ClaudeSessionTarget,
    ClaudeStatusObservation, EnterMode, EnterOutcome, EnterRequest, EnterStatus, SubmitOutcome,
    SubmitRequest, SubmitStatus,
};
use nession_claude_code::conversation_reader::ClaudeConversationReader;
use nession_claude_code::process::is_claude_cli_process;
use nession_claude_code::protocol::messages::{
    MessageContentV1, MessageItemV1, MessageRoleV1, MessagesRequestV1, MessagesResponseV1,
    MessagesStateV1,
};
use nession_protocol::contracts::sandbox::v1::SandboxContextStatus;

use crate::tmux::manager::SessionManager;

/// Bound on one CLI observation. The command is a local read; a hung process is
/// an `unknown`, never a false idle.
const CLI_TIMEOUT: Duration = Duration::from_secs(10);

/// How much of the pane the composer observation reads. The input box is drawn
/// at the bottom of the visible screen; this covers the screen plus enough
/// history that a short pane still captures the whole box (#4665).
const COMPOSER_CAPTURE_LINES: u32 = 200;

/// The bounded submission read-back window (#4665): this many reads, separated
/// by this interval. A prompt Claude has not recorded within the window is an
/// `unknown`, never a verified delivery — the window is a real verification
/// bound, not a retry budget.
const READ_BACK_ITERATIONS: usize = 20;
const READ_BACK_INTERVAL: Duration = Duration::from_millis(500);

/// The Agent-side control backend.
pub struct AgentClaudeControl {
    agent_id: String,
    tmux: Arc<SessionManager>,
    /// The canonical conversation/transcript reader (#3779 P3). Submit's
    /// delivery confirmation reads the addressed conversation through the same
    /// Protocol Units the read Tools use — there is no second transcript
    /// parser here (#4665).
    reader: Arc<dyn ClaudeConversationReader>,
    /// Serializes enter/submit so two calls cannot be concurrent writers to one
    /// transcript. Status observation never takes it.
    write_lock: tokio::sync::Mutex<()>,
}

impl AgentClaudeControl {
    /// Build the backend for one Agent.
    pub fn new(
        agent_id: impl Into<String>,
        tmux: Arc<SessionManager>,
        reader: Arc<dyn ClaudeConversationReader>,
    ) -> Self {
        Self {
            agent_id: agent_id.into(),
            tmux,
            reader,
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

    /// Observe the Claude input box from the Session's pane (#4665).
    ///
    /// The CLI's activity observation is blind to composer content; the pane
    /// capture is the only evidence of input readiness. A capture that cannot
    /// be read is an error the caller refuses on — never a assumed-ready box.
    async fn composer(&self, session_name: &str) -> anyhow::Result<ComposerObservation> {
        let captured = self
            .tmux
            .tmux_dep()
            .ops()
            .capture_pane(session_name, COMPOSER_CAPTURE_LINES)
            .await?;
        Ok(match captured {
            Some(bytes) => observe_composer(&bytes),
            None => ComposerObservation::NotRecognized,
        })
    }

    /// One newest page of the addressed conversation, through the canonical
    /// reader seam. The page is the read-back evidence; `limit` bounds it.
    async fn conversation_page(
        &self,
        session_id: &str,
        conversation_id: &str,
    ) -> MessagesResponseV1 {
        self.reader
            .messages(MessagesRequestV1 {
                session_id: session_id.to_string(),
                conversation_id: conversation_id.to_string(),
                cursor: None,
                limit: Some(50),
            })
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
                // A managed Sandbox execution gives Claude a different
                // filesystem and user-config identity than the host observes.
                // Workspace Trust cannot be prepared against the right root
                // from here (#4073), so the launch is refused instead of
                // writing trust for a directory Claude will not read.
                match self.tmux.sandbox_context(session_name).await {
                    Ok(context) if context.status == SandboxContextStatus::Inside => {
                        return refused(
                            "Claude runs inside a Nession Sandbox execution in this Session; \
                             its in-sandbox working directory and Claude configuration cannot be \
                             verified from the Agent, so Workspace Trust is not prepared"
                                .to_string(),
                        );
                    }
                    Ok(_) => {}
                    Err(error) => {
                        return refused(format!(
                            "the Session's Sandbox context could not be verified before launch: \
                             {error:#}"
                        ));
                    }
                }
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
        // The pre-send baseline: the item ids already recorded in the addressed
        // conversation. Confirmation below requires a *new* exact user message,
        // so a prompt that was submitted earlier cannot vouch for a replay whose
        // Enter was lost. A fresh conversation has no transcript yet —
        // `not_found` is the empty baseline, not a failure.
        //
        // Read before the composer capture so the capture→send window — the
        // only interval in which a concurrent manual keystroke could dirty the
        // composer unseen — stays as short as the capture and the send.
        let baseline = self
            .conversation_page(&request.target.session_id, &request.conversation_id)
            .await;
        let baseline_ids: HashSet<String> = match baseline.state {
            MessagesStateV1::Ready => baseline
                .items
                .iter()
                .map(|item| item.id().to_string())
                .collect(),
            MessagesStateV1::NotFound => HashSet::new(),
            _ => {
                return refused(
                    &status,
                    "the addressed conversation could not be read back before sending; refusing \
                     to submit without a verifiable delivery baseline — read the conversation \
                     and retry"
                        .to_string(),
                );
            }
        };
        // #4665: gate on TUI input readiness, not only process-running +
        // CLI-reported idle. A dirty composer would silently concatenate this
        // prompt onto unsubmitted text; an unrecognised screen (startup, a
        // provider dialog) would lose the keys. Both refuse without sending.
        match self.composer(session_name).await {
            Ok(ComposerObservation::Ready) => {}
            Ok(ComposerObservation::Dirty(evidence)) => {
                return refused(
                    &status,
                    format!(
                        "the Claude composer holds unsubmitted input ({evidence}); refusing to \
                         append — inspect the Session and reconcile the composer before retrying"
                    ),
                );
            }
            Ok(ComposerObservation::NotRecognized) => {
                return refused(
                    &status,
                    "the Claude input box is not verifiably ready (startup or a provider dialog \
                     may be on screen); read status and inspect the Session before retrying"
                        .to_string(),
                );
            }
            Err(error) => {
                return refused(
                    &status,
                    format!(
                        "the Claude input box could not be read; refusing to submit blind: \
                         {error:#}"
                    ),
                );
            }
        }
        match self.send_line(session_name, &request.prompt).await {
            Ok(()) => {
                // #4665: a zero exit from send-keys only proves tmux accepted
                // the keys for the pane PTY. `input_sent` + `verified` requires
                // the prompt's submission to be confirmed by read-back: the
                // exact user message, newly recorded in the addressed
                // conversation. Anything else is a truthful `unknown`.
                let mut confirmed = false;
                for iteration in 0..READ_BACK_ITERATIONS {
                    if iteration > 0 {
                        tokio::time::sleep(READ_BACK_INTERVAL).await;
                    }
                    let page = self
                        .conversation_page(&request.target.session_id, &request.conversation_id)
                        .await;
                    if confirms_submission(&page, &request.prompt, &baseline_ids) {
                        confirmed = true;
                        break;
                    }
                }
                if confirmed {
                    SubmitOutcome {
                        conversation_id: status.conversation_id,
                        status: SubmitStatus::InputSent,
                        observation: ClaudeObservation::Verified,
                        detail: None,
                        observed_at: Utc::now().to_rfc3339(),
                    }
                } else {
                    SubmitOutcome {
                        conversation_id: status.conversation_id,
                        status: SubmitStatus::Unknown,
                        observation: status.observation,
                        detail: Some(
                            "the input was sent but its submission was not confirmed by \
                             read-back within the verification window; read the conversation \
                             back before retrying"
                                .to_string(),
                        ),
                        observed_at: Utc::now().to_rfc3339(),
                    }
                }
            }
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

/// Whether one read-back page confirms the prompt's submission: the **newest
/// user message** in the page has the prompt's exact text and a record id that
/// was not in the pre-send baseline.
///
/// Each condition closes a false-confirmation path:
///
/// - exact text, not a substring — a different prompt that merely contains
///   this one is not this delivery;
/// - a new record id — a prompt submitted earlier cannot vouch for a replay
///   whose Enter was lost;
/// - the newest user position — a submitted prompt is the conversation's
///   newest user turn (Claude's own response appends assistant/tool items,
///   never a user turn), so an older identical prompt that a page shift moves
///   into the window cannot confirm a delivery that never happened, and a
///   newer manual user turn means this prompt is no longer the newest — the
///   answer degrades to `unknown`, never to a false claim.
fn confirms_submission(
    page: &MessagesResponseV1,
    prompt: &str,
    baseline_ids: &HashSet<String>,
) -> bool {
    if page.state != MessagesStateV1::Ready {
        return false;
    }
    let newest_user = page.items.iter().rposition(|item| {
        matches!(
            item,
            MessageItemV1::Message {
                role: MessageRoleV1::User,
                ..
            }
        )
    });
    let Some(MessageItemV1::Message { id, content, .. }) =
        newest_user.and_then(|index| page.items.get(index))
    else {
        return false;
    };
    if baseline_ids.contains(id) {
        return false;
    }
    let text = content
        .iter()
        .map(|block| match block {
            MessageContentV1::Text { text } => text.as_str(),
            MessageContentV1::Unknown => "",
        })
        .collect::<Vec<_>>()
        .join("\n");
    text == prompt
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

/// #4665 SC-03: the delivery classification, proved at the real submit
/// boundary.
///
/// The fixture is the activity suite's pattern: a real tmux Session on the
/// run's private socket, a CLI-compatible `claude` script in the Session's
/// PATH that the real `AgentClaudeControl` observes and sends keys to, and a
/// file-backed reader behind the canonical `ClaudeConversationReader` seam.
/// The script renders the composer shapes the parser knows (empty box, dirty
/// box, startup screen) and either consumes a submitted line into the records
/// file or swallows it — the two TUI outcomes the delivery contract must tell
/// apart. Nothing here touches the host Agent's tmux server, processes or
/// HOME: the socket is the test run's own, every file lives in a tempdir.
///
/// What each test reddens on:
///
/// - confirmed: deriving `input_sent` from anything but a new exact user
///   message in the addressed conversation;
/// - unconfirmed: the original defect — mapping send-keys `Ok` to
///   `input_sent` + `verified` while the TUI never submitted;
/// - dirty/startup: sending into a non-empty or unready composer;
/// - replay: confirming a delivery from a transcript record that predates the
///   send (the lost-Enter replay must stay `unknown`).
#[cfg(test)]
#[cfg(unix)]
mod submit_delivery_tests {
    use super::*;
    use crate::test_support::{install_via_a_child, TestSession};
    use nession_claude_code::conversation_reader::ClaudeConversationReader;
    use nession_claude_code::protocol::conversations::{
        ConversationsRequestV1, ConversationsResponseV1,
    };
    use nession_claude_code::protocol::transcript_record::{
        TranscriptRecordRequestV1, TranscriptRecordResponseV1,
    };
    use nession_claude_code::protocol::transcript_records::{
        TranscriptRecordsRequestV1, TranscriptRecordsResponseV1,
    };
    use std::path::{Path, PathBuf};
    use tokio::time::{sleep, timeout};

    const CONVERSATION: &str = "conversation-1";

    /// The fake CLI: probe branches answer from the state directory; the TUI
    /// branch renders the composer shape named by `state/mode` and consumes
    /// input lines according to `state/consume` (`submit` records each line,
    /// `swallow` discards it, `none` never reads).
    fn write_fake_claude(dir: &Path) -> String {
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).expect("fake bin");
        let state = dir.join("state");
        std::fs::create_dir_all(&state).expect("fake state");
        let script = format!(
            r#"#!/bin/sh
STATE="{state}"
case "$1" in
  --version) echo "2.1.332 (Claude Code)"; exit 0 ;;
  agents)
    pid=$(cat "$STATE/pid" 2>/dev/null || echo 0)
    status=$(cat "$STATE/status" 2>/dev/null || echo idle)
    printf '[{{"kind":"interactive","pid":%s,"sessionId":"{conversation}","cwd":"/tmp","status":"%s"}}]\n' "$pid" "$status"
    exit 0 ;;
esac
echo $$ > "$STATE/pid"
render() {{
  m=$(cat "$STATE/mode" 2>/dev/null || echo ready)
  case "$m" in
    startup)
      printf '\033[2m✻ Welcome to Claude Code\033[0m\n  Starting up…\n' ;;
    dirty)
      printf '\033[2m╭──────────────────────────────────────────╮\033[0m\n'
      printf '\033[2m│\033[0m > leftover unsubmitted prompt\033[2m│\033[0m\n'
      printf '\033[2m╰──────────────────────────────────────────╯\033[0m\n' ;;
    *)
      printf '\033[2m╭──────────────────────────────────────────╮\033[0m\n'
      printf '\033[2m│\033[0m > \033[2mTry "fix lint errors"\033[0m\033[2m│\033[0m\n'
      printf '\033[2m╰──────────────────────────────────────────╯\033[0m\n' ;;
  esac
}}
render
consume=$(cat "$STATE/consume" 2>/dev/null || echo submit)
if [ "$consume" = "none" ]; then
  while :; do sleep 0.2; done
fi
while IFS= read -r line; do
  if [ "$consume" = "submit" ]; then
    printf 'user\t%s\n' "$line" >> "$STATE/records"
  fi
  render
done
"#,
            state = state.display(),
            conversation = CONVERSATION,
        );
        let path = bin.join("claude");
        install_via_a_child(&path, &script).expect("install the fake claude CLI");
        path.to_string_lossy().into_owned()
    }

    /// The reader seam over the records file the fake TUI appends to. Each
    /// `user\t<text>` line is one user message with a stable record id — the
    /// same shape the canonical reader projects from a real transcript, and
    /// the only part of the read-back chain this fixture substitutes. The
    /// canonical transcript parser has its own suite; the live-cli Cases prove
    /// the real chain end to end.
    struct RecordsReader {
        path: PathBuf,
    }

    #[async_trait]
    impl ClaudeConversationReader for RecordsReader {
        async fn conversations(&self, _request: ConversationsRequestV1) -> ConversationsResponseV1 {
            unreachable!("submit reads messages only")
        }

        async fn messages(&self, request: MessagesRequestV1) -> MessagesResponseV1 {
            assert_eq!(
                request.conversation_id, CONVERSATION,
                "the read-back must address the submitted conversation, never another"
            );
            let Ok(text) = std::fs::read_to_string(&self.path) else {
                return MessagesResponseV1::bare(MessagesStateV1::NotFound);
            };
            let items = text
                .lines()
                .enumerate()
                .filter_map(|(index, line)| {
                    let (role, body) = line.split_once('\t')?;
                    (role == "user").then(|| MessageItemV1::Message {
                        id: format!("record-{index}"),
                        timestamp: None,
                        role: MessageRoleV1::User,
                        content: vec![MessageContentV1::Text {
                            text: body.to_string(),
                        }],
                    })
                })
                .collect();
            MessagesResponseV1 {
                items,
                ..MessagesResponseV1::bare(MessagesStateV1::Ready)
            }
        }

        async fn transcript_records(
            &self,
            _request: TranscriptRecordsRequestV1,
        ) -> TranscriptRecordsResponseV1 {
            unreachable!("submit reads messages only")
        }

        async fn transcript_record(
            &self,
            _request: TranscriptRecordRequestV1,
        ) -> TranscriptRecordResponseV1 {
            unreachable!("submit reads messages only")
        }
    }

    struct Fixture {
        /// Declared first so the tempdir outlives every read of its files.
        dir: tempfile::TempDir,
        tmux: Arc<SessionManager>,
        session: TestSession,
        control: AgentClaudeControl,
    }

    impl Fixture {
        async fn new(prefix: &str, mode: &str, consume: &str) -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let script = write_fake_claude(dir.path());
            let state = dir.path().join("state");
            std::fs::write(state.join("mode"), mode).expect("mode");
            std::fs::write(state.join("consume"), consume).expect("consume");
            std::fs::write(state.join("status"), "idle").expect("status");

            let tmux = Arc::new(SessionManager::new());
            let session = TestSession::new(prefix);
            let path = format!(
                "{}:{}",
                dir.path().join("bin").display(),
                std::env::var("PATH").unwrap_or_default()
            );
            let home = dir.path().join("home");
            std::fs::create_dir_all(&home).expect("fixture home");
            tmux.create_session(
                session.name(),
                80,
                24,
                &dir.path().to_string_lossy(),
                &[
                    ("PATH".to_string(), path),
                    ("HOME".to_string(), home.to_string_lossy().into_owned()),
                ],
            )
            .await
            .expect("the fixture creates its tmux Session");
            tmux.tmux_dep()
                .ops()
                .send_keys(session.name(), &script)
                .await
                .expect("the Pane runs the fake claude CLI");

            let reader = Arc::new(RecordsReader {
                path: state.join("records"),
            });
            let control = AgentClaudeControl::new("agent-a", Arc::clone(&tmux), reader);
            let fixture = Self {
                dir,
                tmux,
                session,
                control,
            };
            fixture.wait_until_observed_idle().await;
            fixture
        }

        fn target(&self) -> ClaudeSessionTarget {
            ClaudeSessionTarget {
                agent_id: "agent-a".to_string(),
                session_id: format!("agent-a:{}", self.session.name()),
            }
        }

        fn request(&self, prompt: &str) -> SubmitRequest {
            SubmitRequest {
                target: self.target(),
                conversation_id: CONVERSATION.to_string(),
                prompt: prompt.to_string(),
            }
        }

        fn records(&self) -> Vec<String> {
            let path = self.dir.path().join("state").join("records");
            match std::fs::read_to_string(path) {
                Ok(text) => text
                    .lines()
                    .map(|line| {
                        line.strip_prefix("user\t")
                            .expect("the fake records user lines")
                            .to_string()
                    })
                    .collect(),
                Err(_) => Vec::new(),
            }
        }

        async fn capture(&self) -> String {
            let bytes = self
                .tmux
                .tmux_dep()
                .ops()
                .capture_pane(self.session.name(), COMPOSER_CAPTURE_LINES)
                .await
                .expect("the fixture pane is capturable")
                .unwrap_or_default();
            String::from_utf8_lossy(&bytes).into_owned()
        }

        /// Wait until the real observe path binds the fake CLI and reports the
        /// verified idle conversation — the same guards submit starts from.
        async fn wait_until_observed_idle(&self) {
            timeout(Duration::from_secs(20), async {
                loop {
                    let status = self.control.status(&self.target()).await;
                    if status.observation == ClaudeObservation::Verified
                        && status.process == ClaudeProcessState::Running
                        && status.activity == ClaudeActivityState::Idle
                        && status.conversation_id.as_deref() == Some(CONVERSATION)
                    {
                        return;
                    }
                    sleep(Duration::from_millis(100)).await;
                }
            })
            .await
            .expect("the fake Claude becomes a verified idle conversation");
        }
    }

    #[tokio::test]
    async fn a_confirmed_submission_is_input_sent_and_verified() {
        let fixture = Fixture::new("submit-confirmed", "ready", "submit").await;
        // The issue's shape: a large single-line CJK prompt whose words include
        // tmux key names — delivery must be literal, and the confirmation must
        // come from the recorded message, not the send's exit code.
        //
        // The fixture TUI reads in canonical mode, whose line buffer is 1024
        // bytes on macOS (4096 on Linux); the prompt stays under the smaller
        // bound so the fixture is platform-stable. The real Claude TUI reads
        // raw mode — the issue's full ~500-character injection is the live-cli
        // Case's proof, not this fixture's.
        let prompt = format!("{} Enter Up Down", "修复投递契约".repeat(50));
        let outcome = fixture.control.submit(fixture.request(&prompt)).await;
        assert_eq!(outcome.status, SubmitStatus::InputSent, "{outcome:?}");
        assert_eq!(outcome.observation, ClaudeObservation::Verified);
        assert_eq!(outcome.conversation_id.as_deref(), Some(CONVERSATION));
        assert!(outcome.detail.is_none(), "{outcome:?}");
        assert_eq!(
            fixture.records(),
            vec![prompt.clone()],
            "exactly one prompt, delivered literally, reached the transcript"
        );

        // A legitimate second submit against the now-empty composer confirms
        // again: the baseline excludes the earlier record, it does not block
        // new deliveries.
        let second = fixture.control.submit(fixture.request(&prompt)).await;
        assert_eq!(second.status, SubmitStatus::InputSent, "{second:?}");
        assert_eq!(fixture.records(), vec![prompt.clone(), prompt]);
    }

    #[tokio::test]
    async fn an_unconfirmed_submission_is_unknown_not_verified() {
        // The original defect: tmux accepts both sends (exit 0), the TUI
        // consumes the keys but never submits. The old code answered
        // input_sent + verified here; the contract requires a truthful unknown
        // with read-back guidance.
        let fixture = Fixture::new("submit-swallow", "ready", "swallow").await;
        let outcome = fixture
            .control
            .submit(fixture.request("Review changes"))
            .await;
        assert_eq!(outcome.status, SubmitStatus::Unknown, "{outcome:?}");
        // `observation` describes how the target state was observed (the CLI
        // probe answered); the delivery phase is what must not claim verified
        // submission. `unknown` + guidance is the truthful pair.
        assert!(
            outcome
                .detail
                .as_deref()
                .expect("detail")
                .contains("read the conversation back"),
            "the unknown must carry read-back guidance: {outcome:?}"
        );
        assert!(
            fixture.records().is_empty(),
            "the swallowed prompt must not appear in the transcript"
        );
    }

    #[tokio::test]
    async fn a_dirty_composer_is_refused_without_sending() {
        let fixture = Fixture::new("submit-dirty", "dirty", "none").await;
        let outcome = fixture
            .control
            .submit(fixture.request("A different prompt"))
            .await;
        assert_eq!(outcome.status, SubmitStatus::Refused, "{outcome:?}");
        assert!(
            outcome
                .detail
                .as_deref()
                .expect("detail")
                .contains("unsubmitted input"),
            "the refusal must name the dirty composer: {outcome:?}"
        );
        assert!(fixture.records().is_empty());
        let after = fixture.capture().await;
        assert!(
            !after.contains("A different prompt"),
            "a refused submit must not deliver keys to the pane: {after}"
        );
        assert!(
            after.contains("leftover unsubmitted prompt"),
            "the composer's own text is untouched: {after}"
        );
    }

    #[tokio::test]
    async fn an_unready_tui_is_refused_without_sending() {
        // The startup-swallow guard: no input box on screen means input
        // readiness is not established, so submit refuses instead of sending
        // keys into the void.
        let fixture = Fixture::new("submit-startup", "startup", "none").await;
        let outcome = fixture
            .control
            .submit(fixture.request("Review changes"))
            .await;
        assert_eq!(outcome.status, SubmitStatus::Refused, "{outcome:?}");
        assert!(
            outcome
                .detail
                .as_deref()
                .expect("detail")
                .contains("not verifiably ready"),
            "the refusal must name the unready input box: {outcome:?}"
        );
        assert!(fixture.records().is_empty());
    }

    #[tokio::test]
    async fn a_replay_of_an_already_recorded_prompt_is_not_confirmed_by_the_old_record() {
        // The prompt was submitted once before (its record exists), then a
        // later attempt lost its Enter. The composer is empty again, so the
        // send goes out — but the old transcript record must not vouch for the
        // new delivery: no new record means unknown, never input_sent.
        let fixture = Fixture::new("submit-replay", "ready", "swallow").await;
        let prompt = "Review changes";
        let records = fixture.dir.path().join("state").join("records");
        std::fs::write(&records, format!("user\t{prompt}\n")).expect("seed the earlier record");
        let outcome = fixture.control.submit(fixture.request(prompt)).await;
        assert_eq!(outcome.status, SubmitStatus::Unknown, "{outcome:?}");
        assert_eq!(
            fixture.records(),
            vec![prompt.to_string()],
            "the replay must not add a second transcript record"
        );
    }
}
