//! The Agent's one Session Activity owner (#3800).
//!
//! The coordinator answers three questions, in this order:
//!
//! 1. **Who owns this Pane?** Providers claim only the workload they actually
//!    interpret. A specialized owner is never overridden by generic Shell
//!    foreground evidence — including when the specialized provider can only
//!    say `unknown`. Two specialized claims for one Pane are an ambiguity, not
//!    a race won by registration order, so the Pane is `unknown`.
//! 2. **What is the Pane's level?** The owner's latest observation, fenced by
//!    the tmux Session incarnation, the Pane and the owner generation. A
//!    foreground-workload change retires the previous owner and its
//!    observations first.
//! 3. **What is the Session's level?** Any observed `working` wins; otherwise
//!    any `unknown` makes the Session `unknown`; only a Session whose observed
//!    Panes are all `idle` is `idle`. A Session with no observable Pane is
//!    `unknown`, never `idle`.
//!
//! `attention` is aggregated independently and never becomes a fourth state.
//!
//! ## Bounds
//!
//! State is the latest level per `(Session incarnation, Pane, capability)` —
//! every map is bounded by the observed tmux inventory and the composed
//! providers. `reconcile` probes providers sequentially without holding the
//! state lock, so a slow provider delays a refresh but cannot block reports or
//! readers. A failed enumeration is the caller's to distinguish: `reconcile`'s
//! input is a **complete** snapshot, so its absence is retirement, not error.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use nession_common::session_activity::{
    ActivityLevel, ActivityObservation, ActivityReporter, ActivityState, ForegroundFacts,
    PaneActivitySnapshot, ReportOutcome, SessionActivityContext, SessionActivityProvider,
    SessionActivitySnapshot, WorkloadClass,
};
use tracing::debug;

/// Why a set of providers cannot compose into one coordinator.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ActivityCompositionError {
    #[error("capability id `{id}` is claimed by two Session Activity providers")]
    DuplicateProvider { id: &'static str },
}

/// The Agent-owned Session Activity coordinator.
pub struct SessionActivityCoordinator {
    /// Carried in the authority key. The projection issue (#3804) names it on
    /// the wire; the coordinator itself only needs it to stay identity-scoped.
    #[allow(dead_code)]
    agent_id: String,
    providers: Vec<Arc<dyn SessionActivityProvider>>,
    state: Mutex<CoordinatorState>,
    /// Monotonic owner/workload fence. An `AtomicU64` rather than a field of
    /// the locked state so a generation can be taken while a Pane is borrowed.
    next_generation: AtomicU64,
}

/// One event-driven reporter handle, bound to the provider it was created for.
pub struct ActivityReporterHandle {
    coordinator: Arc<SessionActivityCoordinator>,
    provider_id: String,
}

impl ActivityReporter for ActivityReporterHandle {
    fn report(&self, observed: ActivityObservation) -> ReportOutcome {
        self.coordinator.apply_report(&self.provider_id, observed)
    }
}

#[derive(Debug, Default)]
struct CoordinatorState {
    sessions: BTreeMap<String, SessionState>,
}

#[derive(Debug)]
struct SessionState {
    instance_id: String,
    panes: BTreeMap<String, PaneState>,
}

#[derive(Debug)]
struct PaneState {
    foreground: Option<ForegroundFacts>,
    owner: Option<OwnerRecord>,
    /// Latest accepted level per capability. Only the current owner's entry is
    /// read; every entry is dropped when ownership or the workload changes.
    observations: BTreeMap<String, ActivityLevel>,
    /// Fences reports against the ownership they were observed under.
    owner_generation: u64,
    observed_at: Option<SystemTime>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OwnerRecord {
    capability: String,
}

/// One Pane's target plus every provider's answer.
struct ProbedPane {
    context: SessionActivityContext,
    replies: Vec<ProviderReply>,
}

struct ProviderReply {
    capability: String,
    class: WorkloadClass,
    /// `Err` is an unresolved claim, which is materially different from a
    /// neutral `Ok(None)`: it must not unlock a generic claim.
    level: Result<Option<ActivityLevel>, ()>,
}

enum OwnerResolution<'a> {
    Owner(&'a ProviderReply),
    None,
}

impl SessionActivityCoordinator {
    /// Compose one coordinator from the Agent's activity providers.
    ///
    /// Duplicate capability ids are refused here: two providers reporting for
    /// one capability would make "the owner's latest level" ambiguous, which is
    /// exactly the composition mistake the extension registry refuses for
    /// protocol wires.
    pub fn new(
        agent_id: impl Into<String>,
        providers: Vec<Arc<dyn SessionActivityProvider>>,
    ) -> Result<Arc<Self>, ActivityCompositionError> {
        let mut seen = BTreeSet::new();
        for provider in &providers {
            if !seen.insert(provider.id()) {
                return Err(ActivityCompositionError::DuplicateProvider { id: provider.id() });
            }
        }
        Ok(Arc::new(Self {
            agent_id: agent_id.into(),
            providers,
            state: Mutex::new(CoordinatorState::default()),
            next_generation: AtomicU64::new(0),
        }))
    }

    /// The reporter an event-driven provider uses for its own observations.
    ///
    /// `None` for a capability that was not composed, so no handle can publish
    /// outside the coordinator's authority.
    pub fn reporter(self: &Arc<Self>, provider_id: &str) -> Option<Arc<dyn ActivityReporter>> {
        if !self.providers.iter().any(|p| p.id() == provider_id) {
            return None;
        }
        Some(Arc::new(ActivityReporterHandle {
            coordinator: Arc::clone(self),
            provider_id: provider_id.to_string(),
        }))
    }

    /// Refresh every Pane's owner and level from one complete inventory.
    ///
    /// The caller must not pass an empty slice to mean "enumeration failed":
    /// absence here retires Panes and Sessions. A complete slice is the same
    /// distinction `SessionWatcher` already makes between a failed tmux query
    /// and an observed empty answer.
    pub async fn reconcile(
        self: &Arc<Self>,
        contexts: &[SessionActivityContext],
    ) -> Vec<SessionActivitySnapshot> {
        let targets = self.begin_reconcile(contexts);
        let probed = self.probe_all(targets).await;
        self.finish_reconcile(probed);
        self.snapshots()
    }

    /// Every observed Session's current projection, ordered by Session name.
    pub fn snapshots(&self) -> Vec<SessionActivitySnapshot> {
        let state = self.lock();
        state
            .sessions
            .iter()
            .map(|(name, session)| project_session(name, session))
            .collect()
    }

    /// One Session's current projection. `None` means this Agent has no
    /// verified Pane for it, which a consumer must project as `unknown`.
    pub fn snapshot(&self, session_name: &str) -> Option<SessionActivitySnapshot> {
        let state = self.lock();
        state
            .sessions
            .get(session_name)
            .map(|session| project_session(session_name, session))
    }

    fn lock(&self) -> MutexGuard<'_, CoordinatorState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn next_generation(&self) -> u64 {
        self.next_generation.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Install the verified inventory and return the contexts providers are
    /// probed with.
    ///
    /// A new incarnation, a changed foreground workload or a removed Pane all
    /// drop the previous owner's observations here, **before** any new claim is
    /// considered, so no stale level can be read in the interval.
    fn begin_reconcile(&self, contexts: &[SessionActivityContext]) -> Vec<SessionActivityContext> {
        let mut state = self.lock();

        let mut present_sessions = BTreeSet::new();
        let mut present_panes: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for context in contexts {
            present_sessions.insert(context.session_name.clone());
            present_panes
                .entry(context.session_name.clone())
                .or_default()
                .insert(context.pane_id.clone());
        }
        state
            .sessions
            .retain(|name, _| present_sessions.contains(name));

        let mut targets = Vec::with_capacity(contexts.len());
        for context in contexts {
            // One generation per context is cheap and keeps the borrow simple:
            // it is consumed only by a new Pane or a foreground transition.
            let generation = self.next_generation();

            let session = match state.sessions.get_mut(&context.session_name) {
                Some(session) if session.instance_id == context.session_instance_id => session,
                _ => {
                    // A replacement incarnation is a new Session. The previous
                    // one's Panes and levels die with it even when the name and
                    // Pane ids are reused.
                    state.sessions.insert(
                        context.session_name.clone(),
                        SessionState {
                            instance_id: context.session_instance_id.clone(),
                            panes: BTreeMap::new(),
                        },
                    );
                    state
                        .sessions
                        .get_mut(&context.session_name)
                        .unwrap_or_else(|| unreachable!("the Session was just inserted"))
                }
            };

            let pane = session
                .panes
                .entry(context.pane_id.clone())
                .or_insert_with(|| PaneState {
                    foreground: None,
                    owner: None,
                    observations: BTreeMap::new(),
                    owner_generation: generation,
                    observed_at: None,
                });

            if pane.foreground != context.foreground {
                // The first facts for a Pane and every later workload
                // transition. The old owner is retired *now*: its generation
                // no longer matches, so no report can revive it.
                pane.foreground = context.foreground.clone();
                pane.owner = None;
                pane.observations.clear();
                pane.owner_generation = generation;
            }

            let mut target = context.clone();
            target.owner_generation = pane.owner_generation;
            targets.push(target);
        }

        // Retire Panes this complete inventory no longer contains, then any
        // Session left without one.
        for (name, session) in state.sessions.iter_mut() {
            let empty = BTreeSet::new();
            let present = present_panes.get(name).unwrap_or(&empty);
            session.panes.retain(|pane_id, _| present.contains(pane_id));
        }
        state
            .sessions
            .retain(|_, session| !session.panes.is_empty());

        targets
    }

    async fn probe_all(&self, targets: Vec<SessionActivityContext>) -> Vec<ProbedPane> {
        let mut probed = Vec::with_capacity(targets.len());
        for context in targets {
            let mut replies = Vec::with_capacity(self.providers.len());
            for provider in &self.providers {
                let level = match provider.probe(&context).await {
                    Ok(level) => Ok(level),
                    Err(error) => {
                        debug!(
                            capability = provider.id(),
                            session = %context.session_name,
                            pane = %context.pane_id,
                            "Session Activity probe failed; ownership is unresolved: {error:#}"
                        );
                        Err(())
                    }
                };
                replies.push(ProviderReply {
                    capability: provider.id().to_string(),
                    class: provider.class(),
                    level,
                });
            }
            probed.push(ProbedPane { context, replies });
        }
        probed
    }

    fn finish_reconcile(&self, probed: Vec<ProbedPane>) {
        let mut state = self.lock();
        for pane_result in probed {
            let context = &pane_result.context;
            let Some(session) = state.sessions.get_mut(&context.session_name) else {
                continue;
            };
            if session.instance_id != context.session_instance_id {
                continue;
            }
            let Some(pane) = session.panes.get_mut(&context.pane_id) else {
                continue;
            };
            if pane.owner_generation != context.owner_generation {
                // The inventory changed while this Pane was being probed. The
                // generation fence discards the whole result; the next
                // complete reconcile converges.
                continue;
            }

            match resolve_owner(&pane_result.replies) {
                OwnerResolution::Owner(reply) => {
                    let next = Some(reply.capability.clone());
                    let previous = pane.owner.as_ref().map(|owner| owner.capability.clone());
                    if previous.is_some() && previous != next {
                        // A different owner retires the previous one. The first
                        // claim on a Pane keeps the generation its probe
                        // context carried, so the provider's event reports are
                        // valid immediately rather than only after a second
                        // reconcile.
                        pane.observations.clear();
                        pane.owner_generation = self.next_generation();
                    }
                    pane.owner = Some(OwnerRecord {
                        capability: reply.capability.clone(),
                    });
                    if let Ok(Some(level)) = &reply.level {
                        install_level(pane, &reply.capability, level);
                    }
                }
                OwnerResolution::None => {
                    // Ambiguous or unresolved ownership: retire the previous
                    // owner instead of guessing. `unknown` is the truthful
                    // answer until a verifiable claim exists.
                    if pane.owner.take().is_some() {
                        pane.observations.clear();
                        pane.owner_generation = self.next_generation();
                    }
                }
            }
        }
    }

    fn apply_report(&self, reporter_id: &str, observed: ActivityObservation) -> ReportOutcome {
        if observed.capability_id != reporter_id {
            return ReportOutcome::MismatchedProvider;
        }
        let mut state = self.lock();
        let Some(session) = state.sessions.get_mut(&observed.context.session_name) else {
            return ReportOutcome::UnknownPane;
        };
        if session.instance_id != observed.context.session_instance_id {
            return ReportOutcome::StaleIncarnation;
        }
        let Some(pane) = session.panes.get_mut(&observed.context.pane_id) else {
            return ReportOutcome::UnknownPane;
        };
        if pane.owner_generation != observed.context.owner_generation {
            return ReportOutcome::StaleOwnerGeneration;
        }
        match &pane.owner {
            Some(owner) if owner.capability == reporter_id => {}
            _ => return ReportOutcome::NotOwner,
        }

        install_level(pane, reporter_id, &observed.level)
    }
}

/// Apply one level, preserving the provider's own source ordering.
fn install_level(pane: &mut PaneState, capability: &str, level: &ActivityLevel) -> ReportOutcome {
    match pane.observations.get(capability) {
        Some(current) if level.source_generation < current.source_generation => {
            return ReportOutcome::OutOfOrder
        }
        Some(current) if level.source_generation == current.source_generation => {
            return ReportOutcome::Duplicate
        }
        _ => {}
    }
    pane.observed_at = Some(
        pane.observed_at
            .map_or(level.observed_at, |current| current.max(level.observed_at)),
    );
    pane.observations
        .insert(capability.to_string(), level.clone());
    ReportOutcome::Accepted
}

/// Who owns this Pane, using ownership rather than registration order.
///
/// A specialized claim (including an unresolved specialized claim) is
/// authoritative before any generic Shell claim is considered. Two claims at
/// the same class are ambiguous: `unknown`, not "last one wins".
fn resolve_owner(replies: &[ProviderReply]) -> OwnerResolution<'_> {
    let owned = |class: WorkloadClass| {
        replies
            .iter()
            .filter(|reply| reply.class == class && matches!(reply.level, Ok(Some(_))))
            .collect::<Vec<_>>()
    };
    let unresolved = |class: WorkloadClass| {
        replies
            .iter()
            .any(|reply| reply.class == class && reply.level.is_err())
    };

    let specialized = owned(WorkloadClass::Specialized);
    match specialized.as_slice() {
        [] => {}
        [only] => return OwnerResolution::Owner(only),
        _ => return OwnerResolution::None,
    }
    if unresolved(WorkloadClass::Specialized) {
        // "There is a specialized workload, but I cannot see it" must not let
        // the Shell provider claim `working` for that same Pane.
        return OwnerResolution::None;
    }

    match owned(WorkloadClass::GenericShell).as_slice() {
        [only] => OwnerResolution::Owner(only),
        _ => OwnerResolution::None,
    }
}

fn project_session(name: &str, session: &SessionState) -> SessionActivitySnapshot {
    let panes: Vec<PaneActivitySnapshot> = session
        .panes
        .iter()
        .map(|(pane_id, pane)| {
            let level = pane
                .owner
                .as_ref()
                .and_then(|owner| pane.observations.get(&owner.capability));
            PaneActivitySnapshot {
                pane_id: pane_id.clone(),
                state: level.map_or(ActivityState::Unknown, |level| level.state),
                attention: level.and_then(|level| level.attention),
                owner: pane.owner.as_ref().map(|owner| owner.capability.clone()),
                workload_ref: level.and_then(|level| level.workload_ref.clone()),
                observed_at: level.map(|level| level.observed_at),
            }
        })
        .collect();

    let state = if panes.is_empty() {
        ActivityState::Unknown
    } else if panes
        .iter()
        .any(|pane| pane.state == ActivityState::Working)
    {
        ActivityState::Working
    } else if panes
        .iter()
        .any(|pane| pane.state == ActivityState::Unknown)
    {
        ActivityState::Unknown
    } else {
        ActivityState::Idle
    };
    // Attention is surfaced only for work that is actually working: it is a
    // signal about ongoing work, not an idle prompt rendered as a fourth state.
    let attention = if panes
        .iter()
        .any(|pane| pane.state == ActivityState::Working)
    {
        panes.iter().find_map(|pane| pane.attention)
    } else {
        None
    };

    SessionActivitySnapshot {
        session_name: name.to_string(),
        session_instance_id: session.instance_id.clone(),
        state,
        attention,
        panes,
        observed_at: session
            .panes
            .values()
            .filter_map(|pane| pane.observed_at)
            .max(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nession_common::session_activity::{ActivityState, AttentionState};
    use std::time::{Duration, UNIX_EPOCH};

    type ProbeReply =
        Box<dyn Fn(&SessionActivityContext) -> anyhow::Result<Option<ActivityLevel>> + Send + Sync>;

    struct FakeProvider {
        id: &'static str,
        class: WorkloadClass,
        reply: ProbeReply,
    }

    #[async_trait::async_trait]
    impl SessionActivityProvider for FakeProvider {
        fn id(&self) -> &'static str {
            self.id
        }

        fn class(&self) -> WorkloadClass {
            self.class
        }

        async fn probe(
            &self,
            context: &SessionActivityContext,
        ) -> anyhow::Result<Option<ActivityLevel>> {
            (self.reply)(context)
        }
    }

    fn provider(
        id: &'static str,
        class: WorkloadClass,
        reply: impl Fn(&SessionActivityContext) -> anyhow::Result<Option<ActivityLevel>>
            + Send
            + Sync
            + 'static,
    ) -> Arc<dyn SessionActivityProvider> {
        Arc::new(FakeProvider {
            id,
            class,
            reply: Box::new(reply),
        })
    }

    fn level(state: ActivityState, generation: u64) -> ActivityLevel {
        ActivityLevel {
            state,
            attention: None,
            workload_ref: Some(format!("workload-{generation}")),
            source_generation: generation,
            observed_at: UNIX_EPOCH + Duration::from_secs(generation),
        }
    }

    fn context(session: &str, instance: &str, pane: &str, command: &str) -> SessionActivityContext {
        SessionActivityContext {
            session_name: session.to_string(),
            session_instance_id: instance.to_string(),
            pane_id: pane.to_string(),
            pane_pid: Some(42),
            foreground: Some(ForegroundFacts {
                reference: format!("{pane}:{command}"),
                command: Some(command.to_string()),
            }),
            owner_generation: 0,
        }
    }

    fn coordinator(
        providers: Vec<Arc<dyn SessionActivityProvider>>,
    ) -> Arc<SessionActivityCoordinator> {
        SessionActivityCoordinator::new("agent-a", providers).unwrap()
    }

    /// Reconcile once and read the Session's aggregate state.
    async fn state_after(
        activity: &Arc<SessionActivityCoordinator>,
        contexts: &[SessionActivityContext],
        session: &str,
    ) -> ActivityState {
        activity.reconcile(contexts).await;
        activity
            .snapshot(session)
            .map_or(ActivityState::Unknown, |snapshot| snapshot.state)
    }

    /// A provider closure that records the owner generation it was probed at.
    fn recording_provider(
        recorded: Arc<AtomicU64>,
        state: ActivityState,
        source_generation: u64,
    ) -> Arc<dyn SessionActivityProvider> {
        provider("shell", WorkloadClass::GenericShell, move |context| {
            recorded.store(context.owner_generation, Ordering::Relaxed);
            Ok(Some(level(state, source_generation)))
        })
    }

    // --- The contract itself ------------------------------------------------

    #[test]
    fn the_contract_exposes_only_three_states_and_a_separate_attention_signal() {
        // Exhaustive: adding a state would fail to compile here, which is the
        // point — `attention` is not a state either.
        for state in [
            ActivityState::Working,
            ActivityState::Idle,
            ActivityState::Unknown,
        ] {
            match state {
                ActivityState::Working | ActivityState::Idle | ActivityState::Unknown => {}
            }
        }
        assert_eq!(ActivityState::Working.to_string(), "working");
        assert_eq!(ActivityState::Idle.to_string(), "idle");
        assert_eq!(ActivityState::Unknown.to_string(), "unknown");
        assert_eq!(AttentionState::InputRequired.to_string(), "input_required");
    }

    #[test]
    fn duplicate_capability_ids_are_refused_at_composition() {
        let providers = vec![
            provider("shell", WorkloadClass::GenericShell, |_| Ok(None)),
            provider("shell", WorkloadClass::GenericShell, |_| Ok(None)),
        ];
        let error = match SessionActivityCoordinator::new("agent-a", providers) {
            Ok(_) => panic!("two providers with one capability id must not compose"),
            Err(error) => error,
        };
        assert_eq!(
            error,
            ActivityCompositionError::DuplicateProvider { id: "shell" }
        );
    }

    // --- Aggregation --------------------------------------------------------

    #[tokio::test]
    async fn one_working_pane_makes_the_session_working() {
        let activity = coordinator(vec![provider(
            "shell",
            WorkloadClass::GenericShell,
            |context| {
                Ok(Some(level(
                    if context.pane_id == "%1" {
                        ActivityState::Working
                    } else {
                        ActivityState::Idle
                    },
                    1,
                )))
            },
        )]);
        let contexts = [
            context("dev", "inc-1", "%1", "sleep"),
            context("dev", "inc-1", "%2", "bash"),
        ];

        let snapshot = activity.reconcile(&contexts).await.remove(0);
        assert_eq!(snapshot.state, ActivityState::Working);
    }

    #[tokio::test]
    async fn all_observed_idle_panes_make_the_session_idle() {
        let activity = coordinator(vec![provider("shell", WorkloadClass::GenericShell, |_| {
            Ok(Some(level(ActivityState::Idle, 1)))
        })]);
        let contexts = [
            context("dev", "inc-1", "%1", "bash"),
            context("dev", "inc-1", "%2", "zsh"),
        ];

        let snapshot = activity.reconcile(&contexts).await.remove(0);
        assert_eq!(snapshot.state, ActivityState::Idle);
    }

    #[tokio::test]
    async fn an_unknown_pane_without_working_makes_the_session_unknown() {
        let activity = coordinator(vec![provider(
            "shell",
            WorkloadClass::GenericShell,
            |context| {
                Ok(Some(level(
                    if context.pane_id == "%1" {
                        ActivityState::Idle
                    } else {
                        ActivityState::Unknown
                    },
                    1,
                )))
            },
        )]);
        let contexts = [
            context("dev", "inc-1", "%1", "bash"),
            context("dev", "inc-1", "%2", "bash"),
        ];

        let snapshot = activity.reconcile(&contexts).await.remove(0);
        assert_eq!(snapshot.state, ActivityState::Unknown);
    }

    #[test]
    fn a_session_with_no_observable_pane_is_absent_not_idle() {
        let activity = coordinator(Vec::new());
        assert!(activity.snapshot("never-seen").is_none());
        assert_eq!(activity.snapshots(), Vec::new());
    }

    #[tokio::test]
    async fn a_removed_working_pane_stops_counting() {
        let activity = coordinator(vec![provider("shell", WorkloadClass::GenericShell, |_| {
            Ok(Some(level(ActivityState::Working, 1)))
        })]);
        let both = [
            context("dev", "inc-1", "%1", "sleep"),
            context("dev", "inc-1", "%2", "sleep"),
        ];
        activity.reconcile(&both).await;

        // The remaining Pane is observed idle; the removed Pane's working
        // observation is retired with it.
        let only = [context("dev", "inc-1", "%2", "bash")];
        let snapshot = activity.reconcile(&only).await.remove(0);
        assert_eq!(snapshot.panes.len(), 1);
        assert_eq!(snapshot.panes[0].pane_id, "%2");
    }

    // --- Ownership ----------------------------------------------------------

    #[tokio::test]
    async fn a_specialized_idle_owner_is_not_overridden_by_generic_foreground_work() {
        let activity = coordinator(vec![
            provider("claude-code", WorkloadClass::Specialized, |_| {
                Ok(Some(level(ActivityState::Idle, 1)))
            }),
            provider("shell", WorkloadClass::GenericShell, |_| {
                Ok(Some(level(ActivityState::Working, 1)))
            }),
        ]);
        let contexts = [context("dev", "inc-1", "%1", "claude")];

        let snapshot = activity.reconcile(&contexts).await.remove(0);
        assert_eq!(snapshot.state, ActivityState::Idle);
        assert_eq!(snapshot.panes[0].owner.as_deref(), Some("claude-code"));
    }

    #[tokio::test]
    async fn a_specialized_unknown_owner_blocks_the_generic_claim() {
        let activity = coordinator(vec![
            provider("claude-code", WorkloadClass::Specialized, |_| {
                Ok(Some(level(ActivityState::Unknown, 1)))
            }),
            provider("shell", WorkloadClass::GenericShell, |_| {
                Ok(Some(level(ActivityState::Working, 1)))
            }),
        ]);
        let contexts = [context("dev", "inc-1", "%1", "claude")];

        let snapshot = activity.reconcile(&contexts).await.remove(0);
        assert_eq!(snapshot.state, ActivityState::Unknown);
        assert_eq!(snapshot.panes[0].owner.as_deref(), Some("claude-code"));
    }

    #[tokio::test]
    async fn a_failed_specialized_probe_also_blocks_the_generic_claim() {
        let activity = coordinator(vec![
            provider("claude-code", WorkloadClass::Specialized, |_| {
                anyhow::bail!("status read failed")
            }),
            provider("shell", WorkloadClass::GenericShell, |_| {
                Ok(Some(level(ActivityState::Working, 1)))
            }),
        ]);
        let contexts = [context("dev", "inc-1", "%1", "claude")];

        let snapshot = activity.reconcile(&contexts).await.remove(0);
        assert_eq!(snapshot.state, ActivityState::Unknown);
        assert_eq!(snapshot.panes[0].owner, None);
    }

    #[tokio::test]
    async fn two_specialized_claims_for_one_pane_are_ambiguous_and_unknown() {
        let activity = coordinator(vec![
            provider("claude-code", WorkloadClass::Specialized, |_| {
                Ok(Some(level(ActivityState::Working, 1)))
            }),
            provider("codex", WorkloadClass::Specialized, |_| {
                Ok(Some(level(ActivityState::Idle, 1)))
            }),
        ]);
        let contexts = [context("dev", "inc-1", "%1", "agent")];

        let snapshot = activity.reconcile(&contexts).await.remove(0);
        assert_eq!(snapshot.state, ActivityState::Unknown);
        assert_eq!(
            snapshot.panes[0].owner, None,
            "no registration order or priority may break the tie"
        );
    }

    #[tokio::test]
    async fn a_generic_claim_owns_the_pane_when_no_specialized_provider_claims_it() {
        let activity = coordinator(vec![
            provider("claude-code", WorkloadClass::Specialized, |_| Ok(None)),
            provider("shell", WorkloadClass::GenericShell, |_| {
                Ok(Some(level(ActivityState::Working, 1)))
            }),
        ]);
        let contexts = [context("dev", "inc-1", "%1", "cargo")];

        let snapshot = activity.reconcile(&contexts).await.remove(0);
        assert_eq!(snapshot.state, ActivityState::Working);
        assert_eq!(snapshot.panes[0].owner.as_deref(), Some("shell"));
    }

    // --- Identity and ordering fences --------------------------------------

    #[tokio::test]
    async fn a_changed_foreground_workload_retires_the_previous_owner() {
        let activity =
            coordinator(vec![provider(
                "shell",
                WorkloadClass::GenericShell,
                |context| {
                    Ok(Some(level(
                        if context.foreground.as_ref().is_some_and(|foreground| {
                            foreground.command.as_deref() == Some("sleep")
                        }) {
                            ActivityState::Working
                        } else {
                            ActivityState::Idle
                        },
                        1,
                    )))
                },
            )]);

        let working = [context("dev", "inc-1", "%1", "sleep")];
        assert_eq!(
            state_after(&activity, &working, "dev").await,
            ActivityState::Working
        );

        let idle = [context("dev", "inc-1", "%1", "bash")];
        let after = activity.reconcile(&idle).await.remove(0);
        assert_eq!(after.state, ActivityState::Idle);
        assert_eq!(after.panes[0].workload_ref.as_deref(), Some("workload-1"));
    }

    #[tokio::test]
    async fn a_recreated_session_with_the_same_name_does_not_inherit_activity() {
        let activity = coordinator(vec![provider(
            "shell",
            WorkloadClass::GenericShell,
            |context| {
                Ok(Some(level(
                    if context.session_instance_id == "inc-1" {
                        ActivityState::Working
                    } else {
                        ActivityState::Unknown
                    },
                    1,
                )))
            },
        )]);
        let old = [context("dev", "inc-1", "%1", "sleep")];
        assert_eq!(
            state_after(&activity, &old, "dev").await,
            ActivityState::Working
        );

        let recreated = [context("dev", "inc-2", "%1", "bash")];
        let replacement = activity.reconcile(&recreated).await.remove(0);
        assert_eq!(replacement.session_instance_id, "inc-2");
        assert_eq!(replacement.state, ActivityState::Unknown);
        assert_eq!(
            replacement.panes[0].workload_ref.as_deref(),
            Some("workload-1")
        );
    }

    #[tokio::test]
    async fn duplicate_and_out_of_order_reports_are_rejected() {
        let recorded = Arc::new(AtomicU64::new(0));
        let activity = coordinator(vec![recording_provider(
            Arc::clone(&recorded),
            ActivityState::Idle,
            1,
        )]);
        let contexts = [context("dev", "inc-1", "%1", "bash")];
        activity.reconcile(&contexts).await;
        let generation = recorded.load(Ordering::Relaxed);
        assert_ne!(generation, 0);

        let reporter = activity.reporter("shell").unwrap();
        let report = |state: ActivityState, source_generation: u64| ActivityObservation {
            context: SessionActivityContext {
                owner_generation: generation,
                ..contexts[0].clone()
            },
            capability_id: "shell".to_string(),
            level: level(state, source_generation),
        };

        assert_eq!(
            reporter.report(report(ActivityState::Working, 2)),
            ReportOutcome::Accepted
        );
        assert_eq!(
            reporter.report(report(ActivityState::Working, 2)),
            ReportOutcome::Duplicate
        );
        assert_eq!(
            reporter.report(report(ActivityState::Working, 1)),
            ReportOutcome::OutOfOrder
        );
        assert_eq!(
            activity.snapshot("dev").map(|s| s.state),
            Some(ActivityState::Working)
        );
    }

    #[tokio::test]
    async fn a_duplicate_probe_does_not_clobber_a_newer_event_report() {
        let recorded = Arc::new(AtomicU64::new(0));
        let activity = coordinator(vec![recording_provider(
            Arc::clone(&recorded),
            ActivityState::Idle,
            1,
        )]);
        let contexts = [context("dev", "inc-1", "%1", "bash")];
        let first = activity.reconcile(&contexts).await.remove(0);
        let generation = recorded.load(Ordering::Relaxed);
        assert_eq!(first.state, ActivityState::Idle);

        let reporter = activity.reporter("shell").unwrap();
        assert_eq!(
            reporter.report(ActivityObservation {
                context: SessionActivityContext {
                    owner_generation: generation,
                    ..contexts[0].clone()
                },
                capability_id: "shell".to_string(),
                level: level(ActivityState::Working, 2),
            }),
            ReportOutcome::Accepted
        );

        // The same probe level (source generation 1) is a duplicate of the
        // older observation and must not replace the accepted generation 2.
        let second = activity.reconcile(&contexts).await.remove(0);
        assert_eq!(second.state, ActivityState::Working);
        assert_eq!(
            recorded.load(Ordering::Relaxed),
            generation,
            "an unchanged workload and owner must keep the same fence"
        );
    }

    #[tokio::test]
    async fn an_event_report_cannot_outlive_its_owner_generation() {
        let recorded = Arc::new(AtomicU64::new(0));
        let activity = coordinator(vec![recording_provider(
            Arc::clone(&recorded),
            ActivityState::Idle,
            1,
        )]);
        let contexts = [context("dev", "inc-1", "%1", "bash")];
        activity.reconcile(&contexts).await;
        let generation = recorded.load(Ordering::Relaxed);

        let reporter = activity.reporter("shell").unwrap();
        assert_eq!(
            reporter.report(ActivityObservation {
                context: SessionActivityContext {
                    owner_generation: generation,
                    ..contexts[0].clone()
                },
                capability_id: "shell".to_string(),
                level: level(ActivityState::Working, 10),
            }),
            ReportOutcome::Accepted
        );

        // A workload transition retires the owner.
        let next = [context("dev", "inc-1", "%1", "cargo")];
        activity.reconcile(&next).await;

        assert_eq!(
            reporter.report(ActivityObservation {
                context: SessionActivityContext {
                    owner_generation: generation,
                    ..context("dev", "inc-1", "%1", "cargo")
                },
                capability_id: "shell".to_string(),
                level: level(ActivityState::Working, 20),
            }),
            ReportOutcome::StaleOwnerGeneration
        );
    }

    #[tokio::test]
    async fn a_report_for_an_unknown_pane_or_wrong_capability_is_refused() {
        let recorded = Arc::new(AtomicU64::new(0));
        let activity = coordinator(vec![recording_provider(
            Arc::clone(&recorded),
            ActivityState::Idle,
            1,
        )]);
        let contexts = [context("dev", "inc-1", "%1", "bash")];
        activity.reconcile(&contexts).await;
        let generation = recorded.load(Ordering::Relaxed);
        let reporter = activity.reporter("shell").unwrap();

        assert_eq!(
            reporter.report(ActivityObservation {
                context: context("dev", "inc-1", "%9", "bash"),
                capability_id: "shell".to_string(),
                level: level(ActivityState::Working, 2),
            }),
            ReportOutcome::UnknownPane
        );

        assert_eq!(
            reporter.report(ActivityObservation {
                context: SessionActivityContext {
                    owner_generation: generation,
                    ..contexts[0].clone()
                },
                capability_id: "claude-code".to_string(),
                level: level(ActivityState::Working, 2),
            }),
            ReportOutcome::MismatchedProvider
        );

        assert_eq!(
            reporter.report(ActivityObservation {
                context: SessionActivityContext {
                    owner_generation: generation,
                    session_instance_id: "inc-9".to_string(),
                    ..contexts[0].clone()
                },
                capability_id: "shell".to_string(),
                level: level(ActivityState::Working, 2),
            }),
            ReportOutcome::StaleIncarnation
        );

        assert!(activity.reporter("not-composed").is_none());
    }

    // --- Attention ----------------------------------------------------------

    #[tokio::test]
    async fn attention_is_orthogonal_to_the_activity_state() {
        let activity = coordinator(vec![provider(
            "claude-code",
            WorkloadClass::Specialized,
            |_| {
                Ok(Some(ActivityLevel {
                    state: ActivityState::Working,
                    attention: Some(AttentionState::InputRequired),
                    workload_ref: Some("conversation-1".to_string()),
                    source_generation: 1,
                    observed_at: UNIX_EPOCH + Duration::from_secs(1),
                }))
            },
        )]);
        let contexts = [context("dev", "inc-1", "%1", "claude")];

        let snapshot = activity.reconcile(&contexts).await.remove(0);
        assert_eq!(snapshot.state, ActivityState::Working);
        assert_eq!(snapshot.attention, Some(AttentionState::InputRequired));
        assert_eq!(snapshot.panes[0].state, ActivityState::Working);
        assert_eq!(
            snapshot.panes[0].attention,
            Some(AttentionState::InputRequired)
        );
    }

    #[tokio::test]
    async fn an_idle_session_does_not_surface_an_attention_signal() {
        let activity = coordinator(vec![provider(
            "claude-code",
            WorkloadClass::Specialized,
            |_| {
                Ok(Some(ActivityLevel {
                    state: ActivityState::Idle,
                    attention: Some(AttentionState::InputRequired),
                    workload_ref: None,
                    source_generation: 1,
                    observed_at: UNIX_EPOCH + Duration::from_secs(1),
                }))
            },
        )]);
        let contexts = [context("dev", "inc-1", "%1", "claude")];

        let snapshot = activity.reconcile(&contexts).await.remove(0);
        assert_eq!(snapshot.state, ActivityState::Idle);
        assert_eq!(snapshot.attention, None);
    }

    #[tokio::test]
    async fn a_reconcile_that_changes_ownership_discards_the_old_owners_report() {
        let recorded = Arc::new(AtomicU64::new(0));
        let activity = coordinator(vec![
            provider("claude-code", WorkloadClass::Specialized, {
                let recorded = Arc::clone(&recorded);
                move |context| {
                    recorded.store(context.owner_generation, Ordering::Relaxed);
                    if context
                        .foreground
                        .as_ref()
                        .and_then(|foreground| foreground.command.as_deref())
                        != Some("claude")
                    {
                        return Ok(None);
                    }
                    Ok(Some(level(ActivityState::Working, 1)))
                }
            }),
            provider("shell", WorkloadClass::GenericShell, |_| {
                Ok(Some(level(ActivityState::Working, 1)))
            }),
        ]);
        let claude = [context("dev", "inc-1", "%1", "claude")];
        let first = activity.reconcile(&claude).await.remove(0);
        assert_eq!(first.panes[0].owner.as_deref(), Some("claude-code"));
        let generation = recorded.load(Ordering::Relaxed);

        let shell = [context("dev", "inc-1", "%1", "cargo")];
        let second = activity.reconcile(&shell).await.remove(0);
        assert_eq!(second.panes[0].owner.as_deref(), Some("shell"));

        let claude_reporter = activity.reporter("claude-code").unwrap();
        assert_eq!(
            claude_reporter.report(ActivityObservation {
                context: SessionActivityContext {
                    owner_generation: generation,
                    ..context("dev", "inc-1", "%1", "cargo")
                },
                capability_id: "claude-code".to_string(),
                level: level(ActivityState::Working, 99),
            }),
            ReportOutcome::StaleOwnerGeneration
        );
    }
}
