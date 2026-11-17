//! Session Activity: the work dimension of a Session (#3800).
//!
//! A Session's *work* is independent of its tmux/lifecycle existence, Agent
//! connectivity and client attachment. This module owns only the vocabulary a
//! capability uses to describe its own workload and the observation envelope
//! the Agent's coordinator fences:
//!
//! - [`ActivityState`] is exactly `working | idle | unknown`. There is no
//!   fourth value and no derived state.
//! - [`AttentionState`] is an orthogonal signal carried beside the state, not
//!   encoded as one.
//! - A provider interprets its **own** workload. It never infers activity from
//!   terminal output volume, attachment or CPU use, and it never publishes for
//!   a Session incarnation or Pane it cannot verify.
//!
//! The Agent owns the single [`SessionActivityCoordinator`] that resolves
//! ownership, aggregation and the Session snapshot. Providers live in their
//! capability crates and are composed through [`crate::extension`].
//!
//! [`SessionActivityCoordinator`]: https://docs.rs/nession-agent/LATEST/nession_agent/session/activity/struct.SessionActivityCoordinator.html
//!
//! Claude conversation state, Codex thread turns and shell prompts stay
//! provider-native. Nession receives only the activity level, the optional
//! attention signal and an opaque workload reference.

use std::fmt;
use std::time::SystemTime;

use async_trait::async_trait;

/// What a Session's work is doing right now.
///
/// `Unknown` is a truthful observation, not the absence of one: a capability
/// that exists but cannot determine its business state reports `Unknown`, and
/// a Pane with no owner is `Unknown` too. Neither is ever coerced to `Idle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActivityState {
    /// The owning capability is processing work.
    Working,
    /// The owning capability has finished and is waiting for new work.
    Idle,
    /// No authoritative observation exists right now.
    Unknown,
}

impl ActivityState {
    /// The wire/display token. One spelling for every consumer.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::Idle => "idle",
            Self::Unknown => "unknown",
        }
    }
}

impl fmt::Display for ActivityState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An orthogonal observable signal about the work.
///
/// It is reported **beside** the activity state: a waiting-for-input Claude
/// turn is `Working` with `attention: input_required`, not a fourth state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AttentionState {
    /// The owning capability needs the user before the work can continue.
    InputRequired,
}

impl AttentionState {
    /// The wire/display token.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InputRequired => "input_required",
        }
    }
}

impl fmt::Display for AttentionState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How much of a Pane's workload a provider can authoritatively interpret.
///
/// This is a semantic class, not a priority number. A specialized provider
/// identifies its *own* workload and owns the Pane while that workload is
/// current. A generic Shell provider interprets the shell's foreground work
/// and never overrides a specialized owner — including one whose business
/// state is temporarily `Unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkloadClass {
    /// Claude, Codex, or another capability that interprets its own workload.
    Specialized,
    /// The interactive Shell's foreground command.
    GenericShell,
}

/// The current foreground workload of one tmux Pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForegroundFacts {
    /// Opaque identity of the current foreground workload.
    ///
    /// The coordinator compares this only to detect a change: a different
    /// reference retires the previous owner and its observations before the
    /// next claims are resolved. It is not parsed for meaning.
    pub reference: String,
    /// tmux's `#{pane_current_command}`, when it reports one.
    pub command: Option<String>,
}

/// One Pane's verified identity and current facts.
///
/// Built from a successful tmux enumeration; a failed enumeration is never an
/// empty one ([`SessionActivityCoordinator::reconcile`] treats its input as a
/// complete snapshot).
///
/// [`SessionActivityCoordinator::reconcile`]: https://docs.rs/nession-agent/LATEST/nession_agent/session/activity/struct.SessionActivityCoordinator.html#method.reconcile
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionActivityContext {
    pub session_name: String,
    /// Durable tmux Session identity (`@nession_instance_id`). A same-named
    /// recreation must never inherit the previous incarnation's activity.
    pub session_instance_id: String,
    pub pane_id: String,
    /// Root PID tmux reports for the Pane, when reported.
    pub pane_pid: Option<u32>,
    pub foreground: Option<ForegroundFacts>,
    /// The owner/workload generation this context belongs to.
    ///
    /// A provider copies this into every event report it makes from this
    /// context, so a report cannot outlive the ownership it was observed under.
    pub owner_generation: u64,
}

/// One provider's level for the Pane it currently owns.
///
/// A probe returns `Some(level)` when (and only when) the provider recognizes
/// the Pane's current workload as its own. `state: Unknown` is still ownership:
/// it says "this workload is mine, but I cannot tell its business state right
/// now", which is exactly what must stop a generic Shell claim from reporting
/// `Working`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityLevel {
    pub state: ActivityState,
    pub attention: Option<AttentionState>,
    /// Opaque provider-owned workload reference (conversation id, turn id,
    /// job id). Nession carries it but never interprets it.
    pub workload_ref: Option<String>,
    /// Provider-monotonic source generation for `(incarnation, Pane,
    /// capability)`.
    ///
    /// Higher supersedes; equal is a duplicate and is ignored; lower is
    /// out-of-order and is ignored. A provider is the only writer of its own
    /// ordering.
    pub source_generation: u64,
    pub observed_at: SystemTime,
}

/// One event-driven observation, addressed to the Session and Pane it was
/// observed in.
///
/// An implementation of [`SessionActivityProvider`] may also report through
/// [`ActivityReporter`]; the coordinator accepts it only while this provider is
/// the current owner at the stated generation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityObservation {
    pub context: SessionActivityContext,
    pub capability_id: String,
    pub level: ActivityLevel,
}

/// Why a report was or was not applied.
///
/// A refused report is normal — it is how stale authority is fenced — so the
/// outcome is returned rather than treated as an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportOutcome {
    /// The report is now the Pane's current observation.
    Accepted,
    /// This provider does not own the Pane at this moment.
    NotOwner,
    /// The Pane belongs to a different owner/workload generation now.
    StaleOwnerGeneration,
    /// The same source generation was already applied.
    Duplicate,
    /// An older source generation than the one already applied.
    OutOfOrder,
    /// The Session incarnation is not the one currently observed.
    StaleIncarnation,
    /// The Pane is not part of the current verified inventory.
    UnknownPane,
    /// The report names a different capability than the reporter was built for.
    MismatchedProvider,
}

/// A capability's authoritative interpretation of its own workload.
///
/// Providers are composed by the Agent; they do not query the Server, attach a
/// browser, or maintain a durable activity history. A provider may implement
/// [`probe`](Self::probe), event-driven [`ActivityReporter`] reporting, or both.
#[async_trait]
pub trait SessionActivityProvider: Send + Sync {
    /// Stable capability id carried in observations.
    fn id(&self) -> &'static str;

    /// Whether this provider interprets a specialized workload or generic
    /// Shell foreground work.
    fn class(&self) -> WorkloadClass;

    /// A bounded observation of the Pane, or `None` when the provider does not
    /// recognize the current workload as its own.
    ///
    /// Returning an error means ownership could not be established. The
    /// coordinator treats that as `Unknown` for a specialized provider — it
    /// must not let a generic claim report `Working` over it — and as "no
    /// claim" for a generic provider. A probe must be bounded and cancellable;
    /// the coordinator calls it without holding a lock.
    async fn probe(
        &self,
        context: &SessionActivityContext,
    ) -> anyhow::Result<Option<ActivityLevel>>;
}

/// The event-driven half of a provider.
///
/// A report is a level, not a durable event stream: the coordinator keeps only
/// the latest accepted level per `(Pane, capability)`.
pub trait ActivityReporter: Send + Sync {
    /// Offer one observation. See [`ReportOutcome`] for the refusal cases.
    fn report(&self, observed: ActivityObservation) -> ReportOutcome;
}

/// One Pane's contribution to a Session snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneActivitySnapshot {
    pub pane_id: String,
    pub state: ActivityState,
    pub attention: Option<AttentionState>,
    /// The capability that owns the Pane, when an owner was resolved.
    pub owner: Option<String>,
    pub workload_ref: Option<String>,
    pub observed_at: Option<SystemTime>,
}

/// The Agent-owned Session Activity projection.
///
/// Everything in it is derived from verified Pane owners; it is not a property
/// of `SessionInfo` and never mutates lifecycle, connectivity or attachment
/// state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionActivitySnapshot {
    pub session_name: String,
    pub session_instance_id: String,
    pub state: ActivityState,
    pub attention: Option<AttentionState>,
    pub panes: Vec<PaneActivitySnapshot>,
    /// The newest accepted observation across the Session's Panes.
    pub observed_at: Option<SystemTime>,
}
