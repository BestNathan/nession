//! Reclaim of stale `recovering` Sessions (#2848).
//!
//! The 24-hour sweep has two halves that must not be confused: **selection**
//! asks the database which rows look stale, and **reclamation** decides at the
//! destructive boundary whether a selected row is still that Session. Between
//! the two, an Agent may reconnect and restore the Session; the reclaim then
//! has to be a no-op, not a deletion of the live Session and its Environment
//! Binding.

use std::time::Duration;

use chrono::Utc;

use crate::db::{Database, SessionRow};
use crate::env::EnvService;
use crate::registry::session::SessionRegistry;

/// How long a `recovering` Session may remain untouched before the sweep may
/// reclaim it. The retention policy itself is unchanged (#91); this module
/// only makes enforcing it safe against a concurrent restore.
pub const RECOVERING_RETENTION: Duration = Duration::from_secs(24 * 3600);

/// What one reclamation pass did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SweepOutcome {
    /// Rows the database selected.
    pub selected: usize,
    /// Rows still stale at the destructive boundary, reclaimed with their
    /// Environment Binding.
    pub reclaimed: usize,
    /// Rows restored (or otherwise changed) before the boundary, left alone.
    pub skipped: usize,
}

/// Select the rows that look stale right now, with the exact cutoff the
/// reclamation must re-check.
pub async fn select_stale_recovering(
    db: &Database,
    retention: Duration,
) -> anyhow::Result<(i64, Vec<SessionRow>)> {
    let cutoff = Utc::now().timestamp() - i64::try_from(retention.as_secs()).unwrap_or(i64::MAX);
    let rows = db.list_recovering_sessions_before(cutoff).await?;
    Ok((cutoff, rows))
}

/// Reclaim each selected row **only if it is still that stale recovering
/// Session**.
///
/// The per-Session lifecycle guard serializes this against the Agent's live
/// report for the same Session. A restore that completed before the guard is
/// acquired leaves an active/detached entry and a fresh persisted row, so
/// both the in-memory check and the conditional delete fail and nothing —
/// including the Environment Binding — is destroyed.
pub async fn reclaim_selected(
    rows: &[SessionRow],
    cutoff: i64,
    registry: &SessionRegistry,
    env: &EnvService,
) -> SweepOutcome {
    let mut outcome = SweepOutcome {
        selected: rows.len(),
        ..SweepOutcome::default()
    };
    for row in rows {
        // Lock ordering matches the live-write paths: Agent guard, then
        // Session lifecycle guard. A force-refresh projection for the Agent
        // and this destructive reclaim are therefore mutually exclusive
        // (#2874), and a restore of this Session cannot interleave either
        // (#2848).
        let _agent = registry.agent_guard(&row.agent_id).await;
        let _lifecycle = registry.lifecycle_guard(&row.session_id).await;
        if registry
            .reclaim_stale_recovering_under_lock(&row.agent_id, &row.session_id, cutoff)
            .await
        {
            // The Session is gone; its desired binding and observed cache are
            // no longer a live claim. Cleared while the lifecycle guard is
            // still held, so a restore cannot interleave between the delete
            // and this cleanup.
            env.clear_session_state(&row.session_id).await;
            outcome.reclaimed += 1;
        } else {
            outcome.skipped += 1;
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::binding::BindingRecord;
    use crate::env::MaterializedProfile;
    use crate::registry::session::{SessionInfo, SessionStatus};
    use nession_protocol::contracts::env::v1::{EnvFileRef, EnvSource};
    use std::sync::Arc;

    const HOUR: i64 = 3600;

    async fn fixture() -> (Arc<Database>, SessionRegistry, Arc<EnvService>) {
        let db = Arc::new(Database::new(":memory:").await.expect("in-memory db"));
        let registry = SessionRegistry::new(Arc::clone(&db));
        let env = EnvService::new(Arc::clone(&db));
        (db, registry, env)
    }

    fn session_info(agent_id: &str, name: &str, status: SessionStatus) -> SessionInfo {
        SessionInfo {
            session_id: format!("{agent_id}:{name}"),
            agent_id: agent_id.to_string(),
            session_name: name.to_string(),
            status,
            window_count: 1,
            attached_clients: 0,
            foreground_command: None,
            working_dir: None,
            created_at: chrono::Utc::now() - chrono::Duration::hours(48),
            last_activity: chrono::Utc::now(),
        }
    }

    /// Persist a recovering row and force it beyond the retention cutoff, then
    /// let the registry load it — the exact state a Server restart produces.
    async fn seed_persisted(
        db: &Database,
        agent_id: &str,
        name: &str,
        status: &str,
        age_secs: i64,
    ) -> String {
        let info = session_info(agent_id, name, SessionStatus::Recovering);
        db.insert_session(&info, "recovering")
            .await
            .expect("persist session");
        db.set_session_activity_for_test(
            &info.session_id,
            status,
            chrono::Utc::now().timestamp() - age_secs,
        )
        .await
        .expect("age session");
        info.session_id
    }

    async fn bind(env: &EnvService, session_id: &str, agent_id: &str) {
        env.bindings
            .put(&BindingRecord {
                session_id: session_id.to_string(),
                agent_id: agent_id.to_string(),
                desired_revision: 1,
                profiles: vec![MaterializedProfile {
                    profile: EnvFileRef {
                        name: "prod.env".to_string(),
                        source: EnvSource::Server,
                        agent_id: None,
                    },
                    phase: "attach".to_string(),
                    content_hash: None,
                }],
                updated_at: 0,
            })
            .await
            .expect("persist binding");
    }

    #[tokio::test]
    async fn sc01_a_restored_session_and_its_binding_survive_a_stale_selection() {
        let (db, registry, env) = fixture().await;
        let session_id = seed_persisted(&db, "agent-a", "restored", "recovering", 48 * HOUR).await;
        registry.load_from_db().await;
        bind(&env, &session_id, "agent-a").await;

        // The sweep has selected the row; pause here.
        let (cutoff, selected) =
            select_stale_recovering(&db, Duration::from_secs(24 * HOUR as u64))
                .await
                .expect("select stale rows");
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].session_id, session_id);

        // The Agent reconnects and publishes the live Session; the restore
        // completes before the sweep resumes.
        let restored = session_info("agent-a", "restored", SessionStatus::Active);
        registry.update_session(restored).await;

        // Resume the sweep with the stale selection.
        let outcome = reclaim_selected(&selected, cutoff, &registry, &env).await;

        assert_eq!(outcome.selected, 1);
        assert_eq!(
            outcome.reclaimed, 0,
            "a restored Session must not be reclaimed"
        );
        assert_eq!(outcome.skipped, 1);
        let live = registry
            .get(&session_id)
            .await
            .expect("live Session remains");
        assert_eq!(live.status, SessionStatus::Active);
        let row = db
            .get_session(&session_id)
            .await
            .expect("read row")
            .expect("row remains");
        assert_eq!(row.status, "active");
        let binding_present = env
            .bindings
            .get(&session_id)
            .await
            .expect("read binding")
            .is_some();
        assert!(
            binding_present,
            "the desired Environment Binding must survive"
        );

        eprintln!(
            "#2848 SC-01 measured: selected={} reclaimed={} skipped={} registry={:?} persisted={} binding_present={}",
            outcome.selected, outcome.reclaimed, outcome.skipped, live.status, row.status, binding_present
        );
    }

    #[tokio::test]
    async fn sc02_a_genuinely_stale_session_is_reclaimed_without_touching_another() {
        let (db, registry, env) = fixture().await;
        let stale = seed_persisted(&db, "agent-a", "stale", "recovering", 48 * HOUR).await;
        let live = seed_persisted(&db, "agent-a", "live", "active", 48 * HOUR).await;
        registry.load_from_db().await;
        bind(&env, &stale, "agent-a").await;
        bind(&env, &live, "agent-a").await;

        let (cutoff, selected) =
            select_stale_recovering(&db, Duration::from_secs(24 * HOUR as u64))
                .await
                .expect("select stale rows");
        assert_eq!(selected.len(), 1, "only the recovering row is selected");

        let outcome = reclaim_selected(&selected, cutoff, &registry, &env).await;

        assert_eq!(outcome.reclaimed, 1);
        assert_eq!(outcome.skipped, 0);
        let stale_memory = registry.get(&stale).await.is_some();
        let stale_row = db.get_session(&stale).await.expect("read row").is_some();
        let stale_binding = env
            .bindings
            .get(&stale)
            .await
            .expect("read binding")
            .is_some();
        let live_memory = registry.get(&live).await.is_some();
        let live_binding = env
            .bindings
            .get(&live)
            .await
            .expect("read binding")
            .is_some();

        assert!(!stale_memory, "stale Session removed");
        assert!(!stale_row, "stale persisted row removed");
        assert!(!stale_binding, "stale Session's binding reclaimed");
        assert!(live_memory, "a different Session is untouched");
        assert!(
            db.get_session(&live).await.expect("read row").is_some(),
            "a different Session's persisted row is untouched"
        );
        assert!(live_binding, "a different Session's binding is untouched");

        eprintln!(
            "#2848 SC-02 measured: selected={} reclaimed={} skipped={} stale_memory={stale_memory} stale_row={stale_row} stale_binding={stale_binding} live_memory={live_memory} live_binding={live_binding}",
            outcome.selected, outcome.reclaimed, outcome.skipped
        );
    }
}
