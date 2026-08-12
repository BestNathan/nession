use crate::db::Database;
use chrono::{DateTime, Utc};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: String,
    pub agent_id: String,
    pub session_name: String,
    pub status: SessionStatus,
    pub window_count: u32,
    pub attached_clients: u32,
    pub created_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionStatus {
    Active,
    Detached,
    Recovering,
    Orphaned,
    Zombie,
}

pub struct SessionRegistry {
    sessions: Arc<RwLock<HashMap<String, SessionInfo>>>,
    db: Arc<Database>,
}

impl SessionRegistry {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            db,
        }
    }

    pub async fn load_from_db(&self) {
        match self.db.list_all_sessions().await {
            Ok(rows) => {
                let mut sessions = self.sessions.write().await;
                for row in rows {
                    let created_at =
                        DateTime::from_timestamp(row.created_at, 0).unwrap_or(Utc::now());
                    let last_activity =
                        DateTime::from_timestamp(row.last_activity, 0).unwrap_or(Utc::now());
                    let status = match row.status.as_str() {
                        "active" => SessionStatus::Active,
                        "detached" => SessionStatus::Detached,
                        "zombie" => SessionStatus::Zombie,
                        _ => SessionStatus::Recovering,
                    };
                    let info = SessionInfo {
                        session_id: row.session_id.clone(),
                        agent_id: row.agent_id,
                        session_name: row.session_name,
                        status,
                        window_count: row.window_count,
                        attached_clients: row.attached_clients,
                        created_at,
                        last_activity,
                    };
                    tracing::info!(
                        "Loaded session {} (agent: {}, status: {:?})",
                        info.session_id,
                        info.agent_id,
                        info.status
                    );
                    sessions.insert(row.session_id, info);
                }
                tracing::info!(
                    "Loaded {} sessions from database (recovering)",
                    sessions.len()
                );
            }
            Err(e) => {
                tracing::error!("Failed to load sessions from database: {:#}", e);
            }
        }
    }

    pub async fn update_session(&self, session: SessionInfo) {
        let status = status_str(&session.status);

        // Update the in-memory registry first — it is the live serving path
        // for `list()`/`get()`. The DB is only a restart-recovery cache, so a
        // failed write must not delay or block visibility of the session.
        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session.session_id.clone(), session.clone());
        }

        // Write through to the DB. Failure is logged but non-fatal (the agent
        // is the source of truth and will re-report on reconnect).
        if let Err(e) = self.db.insert_session(&session, status).await {
            tracing::error!("Failed to persist session {}: {:#}", session.session_id, e);
        }
    }

    pub async fn get(&self, session_id: &str) -> Option<SessionInfo> {
        let sessions = self.sessions.read().await;
        sessions.get(session_id).cloned()
    }

    pub async fn list(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions.read().await;
        sessions.values().cloned().collect()
    }

    pub async fn list_by_agent(&self, agent_id: &str) -> Vec<SessionInfo> {
        let sessions = self.sessions.read().await;
        sessions
            .values()
            .filter(|s| s.agent_id == agent_id)
            .cloned()
            .collect()
    }

    pub async fn remove(&self, session_id: &str) {
        if let Err(e) = self.db.delete_session(session_id).await {
            tracing::error!("Failed to delete session {} from DB: {:#}", session_id, e);
        }
        let mut sessions = self.sessions.write().await;
        sessions.remove(session_id);
    }

    pub async fn remove_by_agent(&self, agent_id: &str) -> Vec<String> {
        if let Err(e) = self.db.delete_sessions_by_agent(agent_id).await {
            tracing::error!(
                "Failed to delete sessions for agent {} from DB: {:#}",
                agent_id,
                e
            );
        }
        let mut sessions = self.sessions.write().await;
        let removed: Vec<String> = sessions
            .values()
            .filter(|s| s.agent_id == agent_id)
            .map(|s| s.session_id.clone())
            .collect();
        sessions.retain(|_, s| s.agent_id != agent_id);
        removed
    }

    /// Atomically replace **all** of one agent's sessions with `incoming`.
    ///
    /// Used by the force-refresh path, where the agent has just reported its
    /// live tmux state and the registry must be rebuilt to match. The swap
    /// happens under a single write lock so a concurrent `list()` can never
    /// observe the intermediate empty state — which is exactly what a
    /// `remove_by_agent()` followed by N × `update_session()` would expose.
    ///
    /// Returns the session IDs that disappeared (present before, absent now)
    /// so the caller can release their env-usage locks.
    pub async fn replace_agent_sessions(
        &self,
        agent_id: &str,
        incoming: Vec<SessionInfo>,
    ) -> Vec<String> {
        // Swap in-memory state first — it is the live serving path. Same
        // rationale as `update_session`: a slow or failed DB write must not
        // delay visibility.
        let removed: Vec<String> = {
            let mut sessions = self.sessions.write().await;
            let incoming_ids: std::collections::HashSet<&str> =
                incoming.iter().map(|s| s.session_id.as_str()).collect();
            let removed = sessions
                .values()
                .filter(|s| s.agent_id == agent_id && !incoming_ids.contains(s.session_id.as_str()))
                .map(|s| s.session_id.clone())
                .collect();
            sessions.retain(|_, s| s.agent_id != agent_id);
            for session in &incoming {
                sessions.insert(session.session_id.clone(), session.clone());
            }
            removed
        };

        // Write through to the DB outside the lock. Failures are logged but
        // non-fatal — the agent is the source of truth and re-reports.
        if let Err(e) = self.db.delete_sessions_by_agent(agent_id).await {
            tracing::error!(
                "Failed to clear persisted sessions for agent {}: {:#}",
                agent_id,
                e
            );
        }
        for session in &incoming {
            if let Err(e) = self
                .db
                .insert_session(session, status_str(&session.status))
                .await
            {
                tracing::error!("Failed to persist session {}: {:#}", session.session_id, e);
            }
        }

        removed
    }
}

/// Map a [`SessionStatus`] to the string form persisted in SQLite and sent
/// over the wire. Kept as a free function so both `update_session` and
/// `replace_agent_sessions` share one mapping.
fn status_str(status: &SessionStatus) -> &'static str {
    match status {
        SessionStatus::Active => "active",
        SessionStatus::Detached => "detached",
        SessionStatus::Recovering => "recovering",
        SessionStatus::Orphaned => "orphaned",
        SessionStatus::Zombie => "zombie",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn new_registry() -> SessionRegistry {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        SessionRegistry::new(db)
    }

    fn make_session(agent_id: &str, name: &str) -> SessionInfo {
        SessionInfo {
            session_id: format!("{agent_id}:{name}"),
            agent_id: agent_id.to_string(),
            session_name: name.to_string(),
            status: SessionStatus::Detached,
            window_count: 1,
            attached_clients: 0,
            created_at: Utc::now(),
            last_activity: Utc::now(),
        }
    }

    /// Sorted session IDs — `list()` iterates a HashMap, so order is arbitrary.
    async fn sorted_ids(reg: &SessionRegistry) -> Vec<String> {
        let mut ids: Vec<String> = reg.list().await.into_iter().map(|s| s.session_id).collect();
        ids.sort();
        ids
    }

    #[tokio::test]
    async fn status_str_covers_all_variants() {
        assert_eq!(status_str(&SessionStatus::Active), "active");
        assert_eq!(status_str(&SessionStatus::Detached), "detached");
        assert_eq!(status_str(&SessionStatus::Recovering), "recovering");
        assert_eq!(status_str(&SessionStatus::Orphaned), "orphaned");
        assert_eq!(status_str(&SessionStatus::Zombie), "zombie");
    }

    #[tokio::test]
    async fn replace_swaps_in_the_new_set() {
        let reg = new_registry().await;
        reg.update_session(make_session("a1", "old1")).await;
        reg.update_session(make_session("a1", "old2")).await;

        let removed = reg
            .replace_agent_sessions("a1", vec![make_session("a1", "new1")])
            .await;

        assert_eq!(sorted_ids(&reg).await, vec!["a1:new1"]);
        // Both old sessions are gone; the incoming one is not reported removed.
        let mut removed_sorted = removed;
        removed_sorted.sort();
        assert_eq!(removed_sorted, vec!["a1:old1", "a1:old2"]);
    }

    #[tokio::test]
    async fn replace_leaves_other_agents_untouched() {
        let reg = new_registry().await;
        reg.update_session(make_session("a1", "s1")).await;
        reg.update_session(make_session("a2", "s1")).await;

        reg.replace_agent_sessions("a1", vec![make_session("a1", "s2")])
            .await;

        assert_eq!(sorted_ids(&reg).await, vec!["a1:s2", "a2:s1"]);
    }

    /// A session that survives the refresh must not be reported as removed —
    /// otherwise the caller would wrongly release its env-usage lock.
    #[tokio::test]
    async fn replace_does_not_report_surviving_sessions_as_removed() {
        let reg = new_registry().await;
        reg.update_session(make_session("a1", "keep")).await;
        reg.update_session(make_session("a1", "drop")).await;

        let removed = reg
            .replace_agent_sessions(
                "a1",
                vec![make_session("a1", "keep"), make_session("a1", "add")],
            )
            .await;

        assert_eq!(removed, vec!["a1:drop"]);
        assert_eq!(sorted_ids(&reg).await, vec!["a1:add", "a1:keep"]);
    }

    #[tokio::test]
    async fn replace_with_empty_list_clears_the_agent() {
        let reg = new_registry().await;
        reg.update_session(make_session("a1", "s1")).await;
        reg.update_session(make_session("a2", "s1")).await;

        let removed = reg.replace_agent_sessions("a1", vec![]).await;

        assert_eq!(removed, vec!["a1:s1"]);
        assert_eq!(sorted_ids(&reg).await, vec!["a2:s1"]);
    }

    /// Refreshing an agent the registry has never seen is a no-op insert,
    /// not an error — this is the agent-just-reconnected path.
    #[tokio::test]
    async fn replace_on_unknown_agent_inserts() {
        let reg = new_registry().await;

        let removed = reg
            .replace_agent_sessions("fresh", vec![make_session("fresh", "s1")])
            .await;

        assert!(removed.is_empty());
        assert_eq!(sorted_ids(&reg).await, vec!["fresh:s1"]);
    }

    #[tokio::test]
    async fn remove_by_agent_returns_removed_ids() {
        let reg = new_registry().await;
        reg.update_session(make_session("a1", "s1")).await;
        reg.update_session(make_session("a1", "s2")).await;
        reg.update_session(make_session("a2", "s1")).await;

        let mut removed = reg.remove_by_agent("a1").await;
        removed.sort();

        assert_eq!(removed, vec!["a1:s1", "a1:s2"]);
        assert_eq!(sorted_ids(&reg).await, vec!["a2:s1"]);
    }

    /// The DB is a restart-recovery cache, so a replace must be durable:
    /// reloading from disk reproduces the post-replace state.
    #[tokio::test]
    async fn replace_is_persisted_and_reloadable() {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        let reg = SessionRegistry::new(Arc::clone(&db));
        reg.update_session(make_session("a1", "stale")).await;
        reg.replace_agent_sessions("a1", vec![make_session("a1", "live")])
            .await;

        let reloaded = SessionRegistry::new(db);
        reloaded.load_from_db().await;

        assert_eq!(sorted_ids(&reloaded).await, vec!["a1:live"]);
    }
}
