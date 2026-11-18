//! The Claude control backend seam (`#3779`).
//!
//! The Tool owner is this crate; the **execution authority** is the Agent that
//! owns the Nession Session. The Agent implements [`ClaudeControl`] with its
//! tmux Session state, process discovery and on-demand CLI observation; the
//! Tool modules in [`crate::tools`] own the typed contracts and validation.
//!
//! Process, activity and conversation identity are deliberately separate
//! fields. `idle` is an activity; it does not prove a transcript's last answer
//! was the result of a particular prompt. A missing identity is `None`, never
//! the newest conversation by guess.

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Serialize;

/// The explicit target every Claude control Tool names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeSessionTarget {
    /// The owning Agent.
    pub agent_id: String,
    /// The Nession Session, conventionally `agent_id:name`.
    pub session_id: String,
}

/// Whether a Claude process is running in the named Session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeProcessState {
    /// A process was observed and proved to belong to this Session.
    Running,
    /// The Session is observable and contains no Claude process.
    NotRunning,
    /// The Agent could not determine process membership.
    Unknown,
}

/// Live interactive activity, when verified.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeActivityState {
    /// Working on a turn.
    Busy,
    /// Waiting for input or approval.
    Waiting,
    /// Not working and not waiting.
    Idle,
    /// Not determinable; see `detail`.
    Unknown,
}

/// How the status was obtained.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeObservation {
    /// The verified Agent-view command answered for this Session.
    Verified,
    /// No `claude` executable was found in the Session environment.
    Absent,
    /// The CLI does not offer the verified Agent-view command.
    Unsupported,
    /// The CLI exists but its answer could not be read truthfully.
    CannotObserve,
    /// The process was seen but activity/identity could not be determined.
    Unknown,
}

/// The status answer. Process, activity and identity stay separate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ClaudeStatusObservation {
    /// Running / not running / unknown.
    pub process: ClaudeProcessState,
    /// The verified interactive Claude PID, when this observation bound one.
    ///
    /// A capability-local identity detail (the Agent proved the PID belongs to
    /// the named Session). It is deliberately not projected into the generic
    /// Session Activity model; #3801 uses it to decide which Pane the
    /// capability owns.
    pub process_id: Option<u32>,
    /// Interactive activity, or `unknown`.
    pub activity: ClaudeActivityState,
    /// What Claude reported it is waiting for, when it did.
    pub waiting_for: Option<String>,
    /// The verified conversation id, when one is bound to this Session.
    pub conversation_id: Option<String>,
    /// How the observation was obtained.
    pub observation: ClaudeObservation,
    /// A bounded reason for a non-verified observation.
    pub detail: Option<String>,
    /// RFC 3339 timestamp of the observation.
    pub observed_at: String,
}

impl ClaudeStatusObservation {
    /// No Claude in the Session, as an observed fact.
    pub fn not_running(observed_at: impl Into<String>) -> Self {
        Self {
            process: ClaudeProcessState::NotRunning,
            process_id: None,
            activity: ClaudeActivityState::Unknown,
            waiting_for: None,
            conversation_id: None,
            observation: ClaudeObservation::Verified,
            detail: None,
            observed_at: observed_at.into(),
        }
    }

    /// The status cannot be stated; `observation` and `detail` say why.
    pub fn unavailable(
        observation: ClaudeObservation,
        detail: impl Into<String>,
        observed_at: impl Into<String>,
    ) -> Self {
        Self {
            process: ClaudeProcessState::Unknown,
            process_id: None,
            activity: ClaudeActivityState::Unknown,
            waiting_for: None,
            conversation_id: None,
            observation,
            detail: Some(detail.into()),
            observed_at: observed_at.into(),
        }
    }
}

/// The Agent-owned Claude execution seam.
#[async_trait]
pub trait ClaudeControl: Send + Sync {
    /// Observe one Session's Claude state on demand.
    async fn status(&self, target: &ClaudeSessionTarget) -> ClaudeStatusObservation;
}
