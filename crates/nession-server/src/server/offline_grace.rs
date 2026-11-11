//! Heartbeat-offline grace cleanup (#2997).
//!
//! The heartbeat sweep marks silent Agents Offline and schedules cleanup for
//! each Online→Offline transition. Cleanup belongs to *that* transition: it
//! captures the Agent's offline episode generation and, after the grace period,
//! asks the registry to claim the same episode again before removing anything.
//!
//! The claim is the registry's per-Agent liveness gate. A heartbeat or
//! registration that turns the Agent back Online either wins the gate — and the
//! cleanup then finds the episode over and removes nothing — or waits until the
//! cleanup has finished. There is no window in which a heartbeat can restore the
//! Agent while the removal runs, so an earlier episode's timeout can never
//! delete Sessions that belong to a later, independent offline interval or to a
//! Session that a concurrent recovery just restored.
//!
//! The 30-second policy itself is unchanged (#20/#91); this module only binds it
//! to the episode it was scheduled for.

use std::sync::Arc;
use tracing::info;

use crate::env::EnvService;
use crate::registry::{AgentRegistry, OfflineCleanupGuard, SessionRegistry};
use crate::server::WebClientRegistry;

/// The accepted grace interval (#20/#91): an Agent that has been continuously
/// Offline for this long has its Sessions removed.
pub const OFFLINE_GRACE: std::time::Duration = std::time::Duration::from_secs(30);

/// Wait out the grace interval and clean up the offline episode that scheduled
/// this task.
///
/// Called by the heartbeat sweep, once per Online→Offline transition.
pub async fn schedule_expired_offline_cleanup(
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    env_service: Arc<EnvService>,
    web_client_registry: Arc<WebClientRegistry>,
    agent_id: String,
    offline_generation: u64,
) {
    tokio::time::sleep(OFFLINE_GRACE).await;
    clean_up_expired_offline_agent(
        &agent_registry,
        &session_registry,
        &env_service,
        &web_client_registry,
        &agent_id,
        offline_generation,
    )
    .await;
}

/// Remove the Sessions (and their Environment Binding state) of the Agent whose
/// offline episode `offline_generation` has expired.
///
/// Returns `false` — and removes nothing — when the Agent is no longer in that
/// episode: it recovered, re-registered, or a later offline interval began. The
/// registry's claim is held across the removal, so that decision cannot be
/// invalidated between the eligibility check and the destructive boundary.
pub async fn clean_up_expired_offline_agent(
    agent_registry: &Arc<AgentRegistry>,
    session_registry: &Arc<SessionRegistry>,
    env_service: &Arc<EnvService>,
    web_client_registry: &Arc<WebClientRegistry>,
    agent_id: &str,
    offline_generation: u64,
) -> bool {
    let Some(claim) = agent_registry
        .begin_offline_cleanup(agent_id, offline_generation)
        .await
    else {
        return false;
    };

    info!(
        "Cleaning sessions for offline agent {} (grace period expired)",
        agent_id
    );
    remove_expired_offline_agent_sessions(
        &claim,
        session_registry,
        env_service,
        web_client_registry,
        agent_id,
    )
    .await;
    true
}

/// The destructive half of grace cleanup.
///
/// Takes the [`OfflineCleanupGuard`] as its authority: the guard is only
/// produced by [`AgentRegistry::begin_offline_cleanup`] for the current expired
/// episode, and it keeps that episode current for the whole removal, so this
/// cannot run against a successor episode.
pub async fn remove_expired_offline_agent_sessions(
    _claim: &OfflineCleanupGuard,
    session_registry: &Arc<SessionRegistry>,
    env_service: &Arc<EnvService>,
    web_client_registry: &Arc<WebClientRegistry>,
    agent_id: &str,
) {
    // Collect session IDs first so we can clear their env state after removal.
    let removed = session_registry.remove_by_agent(agent_id).await;
    for session_id in &removed {
        env_service.clear_session_state(session_id).await;
    }
    if !removed.is_empty() {
        // Push the shrunken list so browsers stop showing sessions that are now
        // gone.
        let project_ids = session_registry.project_ids().await;
        web_client_registry
            .broadcast_sessions_changed(Arc::clone(session_registry), &project_ids)
            .await;
    }
}
