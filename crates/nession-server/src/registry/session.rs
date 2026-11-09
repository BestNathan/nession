use crate::db::Database;
use chrono::{DateTime, Utc};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, RwLock};

#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: String,
    pub agent_id: String,
    pub session_name: String,
    pub status: SessionStatus,
    pub window_count: u32,
    pub attached_clients: u32,
    /// Foreground command of the session's active pane, when the agent reports
    /// one. Held in memory only: it is a runtime observation that the agents
    /// re-report after a reconnect, so persisting it would only add write churn.
    pub foreground_command: Option<String>,
    pub working_dir: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    /// Durable tmux Session instance identity. `None` for a legacy Session or
    /// before the Agent's first report.
    pub instance_id: Option<String>,
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
    /// One lifecycle lock per Session id (#2848).
    ///
    /// A Session's live report, creation claim, removal and stale-row
    /// reclamation must not interleave: the reclaim path deletes a persisted
    /// recovering row selected earlier, and a restore that commits first must
    /// make that deletion a no-op. Weak entries so the map does not grow with
    /// every Session id the Server has ever seen; a live guard keeps its lock
    /// alive until every waiter has finished.
    lifecycle_locks: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    /// One lock per Agent id, ordered **before** `lifecycle_guard` (#2874).
    ///
    /// A force-refresh projects an Agent's whole Session set from a snapshot
    /// taken when `agent.session.report` was sent. Every mutation of that
    /// Agent's Sessions takes this lock, so the refresh's multi-statement
    /// rewrite can never interleave with a newer live report.
    agent_locks: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    /// Monotonic count of Session-state mutations per Agent (#2874).
    ///
    /// The force-refresh captures this before querying the Agent and asks the
    /// projection to apply only if it has not moved. An update that commits
    /// while the refresh reply is in flight therefore invalidates the refresh:
    /// a stale snapshot can never overwrite a newer authoritative report, and
    /// its persisted rewrite never erases it.
    agent_generations: Mutex<HashMap<String, u64>>,
    /// Test seam: when set, a refresh pauses after its atomic in-memory swap
    /// and before the persisted rewrite, so a Case can hold a concurrent
    /// update against the projection boundary.
    #[cfg(test)]
    refresh_db_pause: Mutex<Option<(Arc<tokio::sync::Barrier>, Arc<tokio::sync::Barrier>)>>,
    db: Arc<Database>,
}

impl SessionRegistry {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            lifecycle_locks: Mutex::new(HashMap::new()),
            agent_locks: Mutex::new(HashMap::new()),
            agent_generations: Mutex::new(HashMap::new()),
            #[cfg(test)]
            refresh_db_pause: Mutex::new(None),
            db,
        }
    }

    /// Serialize one Agent's Session-set mutations.
    ///
    /// Always acquired before [`Self::lifecycle_guard`]; holding it across the
    /// in-memory change and the persisted write is what makes a force-refresh
    /// and a live Agent report mutually exclusive for that Agent (#2874).
    /// Different Agents never contend.
    pub(crate) async fn agent_guard(&self, agent_id: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self
                .agent_locks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(existing) = locks.get(agent_id).and_then(Weak::upgrade) {
                existing
            } else {
                let lock = Arc::new(AsyncMutex::new(()));
                locks.insert(agent_id.to_string(), Arc::downgrade(&lock));
                lock
            }
        };
        lock.lock_owned().await
    }

    /// The Agent's current Session-state generation.
    ///
    /// A force-refresh reads this **before** asking the Agent for its live
    /// Sessions and passes it back to [`Self::replace_agent_sessions`].
    pub(crate) fn agent_generation(&self, agent_id: &str) -> u64 {
        self.agent_generations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(agent_id)
            .copied()
            .unwrap_or(0)
    }

    /// Mark one Agent Session-state mutation. Generations are never reused for
    /// an Agent id, even after the Agent is removed, so an old refresh can
    /// never match a re-registered Agent by accident.
    fn bump_agent_generation(&self, agent_id: &str) {
        let mut generations = self
            .agent_generations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let generation = generations.entry(agent_id.to_string()).or_insert(0);
        *generation += 1;
    }

    /// Serialize one Session's lifecycle transitions.
    ///
    /// Held across the in-memory replacement, the persisted write and — for
    /// reclamation — the Environment Binding cleanup. A stale-row sweep and a
    /// restore of the same Session therefore have one winner: whichever
    /// acquires this guard first. Different Sessions never contend.
    pub(crate) async fn lifecycle_guard(&self, session_id: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self
                .lifecycle_locks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(existing) = locks.get(session_id).and_then(Weak::upgrade) {
                existing
            } else {
                let lock = Arc::new(AsyncMutex::new(()));
                locks.insert(session_id.to_string(), Arc::downgrade(&lock));
                lock
            }
        };
        lock.lock_owned().await
    }

    pub async fn load_from_db(&self) {
        match self.db.list_all_sessions().await {
            Ok(rows) => {
                let mut sessions = self.sessions.write().await;
                for row in rows {
                    let info = session_info_from_row(row);
                    tracing::info!(
                        "Loaded session {} (agent: {}, status: {:?})",
                        info.session_id,
                        info.agent_id,
                        info.status
                    );
                    sessions.insert(info.session_id.clone(), info);
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

    /// The live Session→Project membership map for a Web projection (#3082).
    ///
    /// A binding belongs to one Session incarnation: the tmux `created_at` the
    /// Agent reports. A pending binding written by create matches the
    /// create-placeholder window; a binding whose timestamp does not match the
    /// current row is omitted (and is invalidated by the report/refresh path),
    /// so a reused `agent_id:session_name` never inherits an old Project.
    pub async fn project_ids_for(&self, sessions: &[SessionInfo]) -> HashMap<String, String> {
        match self.db.list_session_project_bindings().await {
            Ok(bindings) => bindings
                .into_iter()
                .filter_map(|binding| {
                    let session = sessions
                        .iter()
                        .find(|session| session.session_id == binding.session_id)?;
                    let matches_incarnation = if !binding.incarnation_id.is_empty() {
                        session.instance_id.as_deref() == Some(binding.incarnation_id.as_str())
                    } else if session.instance_id.is_some() {
                        // A pending create-time membership applies to the first
                        // incarnation reported inside its short window.
                        session.created_at.timestamp() >= binding.updated_at.saturating_sub(300)
                    } else {
                        session.created_at.timestamp() >= binding.updated_at.saturating_sub(300)
                    };
                    matches_incarnation.then_some((binding.session_id, binding.project_id))
                })
                .collect(),
            Err(e) => {
                tracing::error!("Failed to read session project bindings: {e:#}");
                HashMap::new()
            }
        }
    }

    /// All live Sessions with their Project membership.
    pub async fn project_ids(&self) -> HashMap<String, String> {
        let sessions = self.list().await;
        self.project_ids_for(&sessions).await
    }

    pub async fn update_session(&self, session: SessionInfo) {
        // Ordered before the per-Session guard: a force-refresh holds this
        // Agent guard for its whole projection, so a live report either
        // commits before the refresh captures its generation (and invalidates
        // it) or waits for the projection and then applies on top (#2874).
        let _agent = self.agent_guard(&session.agent_id).await;
        // Serialized with the stale-row reclaim path: a restore that acquires
        // this guard before the sweep makes the sweep's conditional deletion a
        // no-op (#2848).
        let _lifecycle = self.lifecycle_guard(&session.session_id).await;
        let status = status_str(&session.status);

        // Update the in-memory registry first — it is the live serving path
        // for `list()`/`get()`. The DB is only a restart-recovery cache, so a
        // failed write must not delay or block visibility of the session.
        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session.session_id.clone(), session.clone());
        }
        self.bump_agent_generation(&session.agent_id);

        // Write through to the DB. Failure is logged but non-fatal (the agent
        // is the source of truth and will re-report on reconnect).
        if let Err(e) = self.db.insert_session(&session, status).await {
            tracing::error!("Failed to persist session {}: {:#}", session.session_id, e);
        }
        // Adopt a pending create-time membership with the Agent's first report,
        // or invalidate it when this is a new incarnation of the same name.
        if let Err(e) = self
            .db
            .adopt_or_invalidate_session_project_binding(
                &session.session_id,
                session.instance_id.as_deref(),
                Some(session.created_at.timestamp()),
            )
            .await
        {
            tracing::error!(
                "Failed to reconcile project membership for {}: {e:#}",
                session.session_id
            );
        }
    }

    /// Register only the create-time placeholder, without overwriting an
    /// authoritative Agent report that may have raced ahead of the command
    /// acknowledgement (#2021). The presence check and insert MUST share
    /// one write lock: `get()` followed by `update_session()` would recreate
    /// the same read/insert race.
    ///
    /// Return false when the row already exists; creation still succeeded,
    /// and the caller may broadcast the existing authoritative row.
    pub async fn insert_session_if_absent(&self, session: SessionInfo) -> bool {
        let _agent = self.agent_guard(&session.agent_id).await;
        let _lifecycle = self.lifecycle_guard(&session.session_id).await;
        let inserted = {
            let mut sessions = self.sessions.write().await;
            match sessions.entry(session.session_id.clone()) {
                std::collections::hash_map::Entry::Vacant(v) => {
                    v.insert(session.clone());
                    true
                }
                std::collections::hash_map::Entry::Occupied(_) => false,
            }
        };
        if inserted {
            self.bump_agent_generation(&session.agent_id);
            // The DB is the recovery cache, never the serving authority.
            // Like update_session, do not hold a map write lock during I/O.
            if let Err(e) = self
                .db
                .insert_session(&session, status_str(&session.status))
                .await
            {
                tracing::error!(
                    "Failed to persist new session {}: {:#}",
                    session.session_id,
                    e
                );
            }
        }
        inserted
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
        // Resolve the Agent before taking the guards; a Session id is
        // canonically `agent_id:session_name`, and the in-memory entry is the
        // authoritative source while it exists.
        let agent_id = {
            let sessions = self.sessions.read().await;
            sessions.get(session_id).map(|s| s.agent_id.clone())
        }
        .or_else(|| {
            session_id
                .split_once(':')
                .map(|(agent_id, _)| agent_id.to_owned())
        });
        let _agent = match agent_id.as_deref() {
            Some(agent_id) => Some(self.agent_guard(agent_id).await),
            None => None,
        };
        let _lifecycle = self.lifecycle_guard(session_id).await;
        if let Err(e) = self.db.delete_session(session_id).await {
            tracing::error!("Failed to delete session {} from DB: {:#}", session_id, e);
        }
        let mut sessions = self.sessions.write().await;
        sessions.remove(session_id);
        if let Some(agent_id) = agent_id {
            self.bump_agent_generation(&agent_id);
        }
    }

    /// Reclaim one Session selected by the stale-recovering sweep at `cutoff`.
    ///
    /// **The caller must hold [`Self::agent_guard`] for this Session's Agent
    /// and [`Self::lifecycle_guard`] for the Session** for the whole
    /// destructive sequence (this call and the Environment Binding cleanup
    /// that follows). The guards are what make the reclaim conditional: a
    /// restore that completed first has already replaced the in-memory entry
    /// and the persisted row, so both checks below fail and nothing is
    /// destroyed (#2848). The Agent guard also orders the reclaim against a
    /// force-refresh projection for the same Agent (#2874).
    ///
    /// Returns `true` only when the persisted row was still the stale
    /// recovering row and was deleted. The in-memory entry is removed in the
    /// same decision, so the caller may then clear the Session's Environment
    /// Binding.
    pub(crate) async fn reclaim_stale_recovering_under_lock(
        &self,
        agent_id: &str,
        session_id: &str,
        cutoff: i64,
    ) -> bool {
        // The live registry is the authority: a restore writes the fresh
        // status and activity here before its persisted write completes.
        let removed_from_memory = {
            let mut sessions = self.sessions.write().await;
            match sessions.get(session_id) {
                Some(current)
                    if current.status != SessionStatus::Recovering
                        || current.last_activity.timestamp() >= cutoff =>
                {
                    return false;
                }
                Some(_) => {
                    sessions.remove(session_id);
                    true
                }
                // A persisted row with no in-memory entry (for example after
                // a restart that has not loaded it) is decided by the row.
                None => false,
            }
        };

        match self
            .db
            .delete_recovering_session_before(session_id, cutoff)
            .await
        {
            Ok(true) => {
                self.bump_agent_generation(agent_id);
                true
            }
            Ok(false) => {
                // The persisted row changed while the sweep held it — the
                // restore won. Reclaiming nothing is the only safe result.
                // If the sweep had already removed the in-memory entry, put
                // the current row back rather than serving a deleted view; a
                // locking restore cannot have run here (the guard is held),
                // but a non-locking writer may have replaced the row.
                if removed_from_memory {
                    match self.db.get_session(session_id).await {
                        Ok(Some(row)) => {
                            let info = session_info_from_row(row);
                            let mut sessions = self.sessions.write().await;
                            sessions.insert(session_id.to_string(), info);
                        }
                        Ok(None) => {}
                        Err(e) => {
                            tracing::error!(
                                "Failed to reload session {} after a skipped reclaim: {:#}",
                                session_id,
                                e
                            );
                        }
                    }
                }
                false
            }
            Err(e) => {
                tracing::error!(
                    "Failed to reclaim stale recovering session {}: {:#}",
                    session_id,
                    e
                );
                false
            }
        }
    }

    pub async fn remove_by_agent(&self, agent_id: &str) -> Vec<String> {
        let _agent = self.agent_guard(agent_id).await;
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
        drop(sessions);
        self.bump_agent_generation(agent_id);
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
    /// `observed_generation` is the Agent's generation **before** the refresh
    /// request was sent (see [`Self::agent_generation`]). If a newer live
    /// report committed while the reply was in flight, the snapshot is stale:
    /// the projection is skipped in its entirety and the newer report wins
    /// (#2874). The check and the rewrite happen under the per-Agent guard, so
    /// nothing can commit between them.
    ///
    /// Returns the session IDs that disappeared (present before, absent now)
    /// so the caller can release their env-usage locks. A skipped stale
    /// refresh removes nothing.
    pub async fn replace_agent_sessions(
        &self,
        agent_id: &str,
        incoming: Vec<SessionInfo>,
        observed_generation: u64,
    ) -> Vec<String> {
        let _agent = self.agent_guard(agent_id).await;

        if self.agent_generation(agent_id) != observed_generation {
            tracing::debug!(
                "Skipping stale session refresh for agent {}: generation moved from {} to {}",
                agent_id,
                observed_generation,
                self.agent_generation(agent_id)
            );
            return Vec::new();
        }

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
        self.bump_agent_generation(agent_id);

        // Test seam: the Case holds this projection while a newer Agent
        // report arrives, proving the two cannot interleave.
        #[cfg(test)]
        {
            let pause = self
                .refresh_db_pause
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            if let Some((reached, release)) = pause {
                reached.wait().await;
                release.wait().await;
            }
        }

        // Write through to the DB outside the lock, as one transaction.
        // Failures are logged but non-fatal — the agent is the source of
        // truth and re-reports.
        if let Err(e) = self
            .db
            .replace_sessions_for_agent(agent_id, &incoming)
            .await
        {
            tracing::error!(
                "Failed to persist session replacement for agent {}: {:#}",
                agent_id,
                e
            );
        }

        removed
    }
}

/// Project a persisted row into the live registry's shape.
///
/// One owner for the row→memory mapping: the startup load and the
/// skipped-reclaim reload must agree, or a restored Session would come back
/// with a different status depending on which path reloaded it.
fn session_info_from_row(row: crate::db::SessionRow) -> SessionInfo {
    let created_at = DateTime::from_timestamp(row.created_at, 0).unwrap_or_else(Utc::now);
    let last_activity = DateTime::from_timestamp(row.last_activity, 0).unwrap_or_else(Utc::now);
    let status = match row.status.as_str() {
        "active" => SessionStatus::Active,
        "detached" => SessionStatus::Detached,
        "zombie" => SessionStatus::Zombie,
        _ => SessionStatus::Recovering,
    };
    SessionInfo {
        session_id: row.session_id,
        agent_id: row.agent_id,
        session_name: row.session_name,
        status,
        window_count: row.window_count,
        attached_clients: row.attached_clients,
        // Not persisted: it is re-reported by the agent's first update after a
        // reconnect.
        foreground_command: None,
        working_dir: None,
        instance_id: row.instance_id,
        created_at,
        last_activity,
    }
}

/// Map a [`SessionStatus`] to the string form persisted in SQLite and sent
/// over the wire. Kept as a free function so the registry's single-row writes
/// and the database layer's transactional replacement share one mapping.
pub(crate) fn status_str(status: &SessionStatus) -> &'static str {
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
            foreground_command: None,
            working_dir: None,
            instance_id: None,
            created_at: Utc::now(),
            last_activity: Utc::now(),
        }
    }

    /// Capture the generation, then replace — the same sequence the
    /// force-refresh path uses when nothing else changed.
    async fn replace(
        reg: &SessionRegistry,
        agent_id: &str,
        incoming: Vec<SessionInfo>,
    ) -> Vec<String> {
        let generation = reg.agent_generation(agent_id);
        reg.replace_agent_sessions(agent_id, incoming, generation)
            .await
    }

    /// The Agent's report can race the command's success reply. The reply
    /// must not write an older synthetic `None` command over an actual pane
    /// status, working directory or authoritative lifecycle fields (#2021).
    #[tokio::test]
    async fn create_placeholder_after_agent_report_preserves_authoritative_session() {
        let reg = new_registry().await;
        let mut report = make_session("a1", "race");
        report.foreground_command = Some("bash".to_owned());
        report.working_dir = Some("/srv/project".to_owned());
        report.status = SessionStatus::Active;
        report.attached_clients = 2;
        report.window_count = 3;
        reg.update_session(report.clone()).await;

        let mut stale_placeholder = make_session("a1", "race");
        stale_placeholder.status = SessionStatus::Detached;
        assert!(
            !reg.insert_session_if_absent(stale_placeholder).await,
            "create success can never replace an earlier Agent report"
        );
        let current = reg.get("a1:race").await.unwrap();
        assert_eq!(current.foreground_command.as_deref(), Some("bash"));
        assert_eq!(current.working_dir.as_deref(), Some("/srv/project"));
        assert_eq!(current.status, SessionStatus::Active);
        assert_eq!(current.attached_clients, 2);
        assert_eq!(current.window_count, 3);
        assert_eq!(current.created_at, report.created_at);
        assert_eq!(current.last_activity, report.last_activity);
    }

    /// The reverse ordering still shows the session immediately. The later
    /// Agent report replaces the placeholder as the new actual authority.
    #[tokio::test]
    async fn create_placeholder_before_agent_report_remains_visible_and_updates() {
        let reg = new_registry().await;
        let placeholder = make_session("a1", "race");
        assert!(reg.insert_session_if_absent(placeholder.clone()).await);
        assert!(
            !reg.insert_session_if_absent(placeholder).await,
            "duplicate create reply cannot replace an existing row"
        );
        assert_eq!(reg.list().await.len(), 1);
        assert!(reg
            .get("a1:race")
            .await
            .unwrap()
            .foreground_command
            .is_none());

        let mut report = make_session("a1", "race");
        report.foreground_command = Some("bash".to_owned());
        report.status = SessionStatus::Active;
        reg.update_session(report).await;
        let actual = reg.get("a1:race").await.unwrap();
        assert_eq!(actual.foreground_command.as_deref(), Some("bash"));
        assert_eq!(actual.status, SessionStatus::Active);
        assert_eq!(reg.list().await.len(), 1);
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

        let removed = replace(&reg, "a1", vec![make_session("a1", "new1")]).await;

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

        replace(&reg, "a1", vec![make_session("a1", "s2")]).await;

        assert_eq!(sorted_ids(&reg).await, vec!["a1:s2", "a2:s1"]);
    }

    /// A session that survives the refresh must not be reported as removed —
    /// otherwise the caller would wrongly release its env-usage lock.
    #[tokio::test]
    async fn replace_does_not_report_surviving_sessions_as_removed() {
        let reg = new_registry().await;
        reg.update_session(make_session("a1", "keep")).await;
        reg.update_session(make_session("a1", "drop")).await;

        let removed = replace(
            &reg,
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

        let removed = replace(&reg, "a1", vec![]).await;

        assert_eq!(removed, vec!["a1:s1"]);
        assert_eq!(sorted_ids(&reg).await, vec!["a2:s1"]);
    }

    /// Refreshing an agent the registry has never seen is a no-op insert,
    /// not an error — this is the agent-just-reconnected path.
    #[tokio::test]
    async fn replace_on_unknown_agent_inserts() {
        let reg = new_registry().await;

        let removed = replace(&reg, "fresh", vec![make_session("fresh", "s1")]).await;

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
        replace(&reg, "a1", vec![make_session("a1", "live")]).await;

        let reloaded = SessionRegistry::new(db);
        reloaded.load_from_db().await;

        assert_eq!(sorted_ids(&reloaded).await, vec!["a1:live"]);
    }

    /// #2874 SC-01: a force-refresh snapshot is stale once a newer live
    /// report committed while its reply was in flight. The refresh must not
    /// erase the newer report, and the newer report must survive a reload.
    #[tokio::test]
    async fn sc01_a_stale_refresh_cannot_erase_a_newer_agent_report() {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        let reg = SessionRegistry::new(Arc::clone(&db));
        reg.update_session(make_session("a1", "old")).await;

        // The force-refresh sends its query now...
        let observed_generation = reg.agent_generation("a1");

        // ...and while the reply is in flight a newer authoritative report
        // commits.
        let mut newer = make_session("a1", "new");
        newer.status = SessionStatus::Active;
        newer.window_count = 9;
        newer.attached_clients = 3;
        reg.update_session(newer).await;

        // The old snapshot arrives late.
        let removed = reg
            .replace_agent_sessions("a1", vec![make_session("a1", "old")], observed_generation)
            .await;

        assert!(
            removed.is_empty(),
            "a skipped stale refresh must release no Environment Bindings"
        );
        let live = reg.get("a1:new").await.expect("newer report remains live");
        assert_eq!(live.status, SessionStatus::Active);
        assert_eq!(live.window_count, 9);
        assert_eq!(live.attached_clients, 3);

        let row = reg
            .db
            .get_session("a1:new")
            .await
            .expect("read row")
            .expect("newer report remains persisted");
        assert_eq!(row.status, "active");
        assert_eq!(row.window_count, 9);
        assert_eq!(row.attached_clients, 3);

        // A Server restart must not lose or regress the newer report.
        let reloaded = SessionRegistry::new(Arc::clone(&reg.db));
        reloaded.load_from_db().await;
        let persisted = reloaded
            .get("a1:new")
            .await
            .expect("newer report survives reload");
        assert_eq!(persisted.status, SessionStatus::Active);
        assert_eq!(persisted.window_count, 9);

        eprintln!(
            "#2874 SC-01 measured: observed_generation={observed_generation} current_generation={} removed={} live_status={:?} live_windows={} persisted_status={} persisted_windows={} reload_windows={}",
            reg.agent_generation("a1"),
            removed.len(),
            live.status,
            live.window_count,
            row.status,
            row.window_count,
            persisted.window_count
        );
    }

    /// #2874 SC-01: the persisted rewrite itself cannot interleave a newer
    /// report. The refresh is held after its atomic in-memory swap; an update
    /// that arrives there waits for the Agent guard and then applies on top,
    /// so the newer report is what a reload sees.
    #[tokio::test]
    async fn sc01_a_refresh_projection_and_a_live_update_are_serialized() {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        let reg = Arc::new(SessionRegistry::new(Arc::clone(&db)));
        reg.update_session(make_session("a1", "old")).await;
        let observed_generation = reg.agent_generation("a1");

        let reached = Arc::new(tokio::sync::Barrier::new(2));
        let release = Arc::new(tokio::sync::Barrier::new(2));
        *reg.refresh_db_pause
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((Arc::clone(&reached), Arc::clone(&release)));

        let refresh = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move {
                reg.replace_agent_sessions(
                    "a1",
                    vec![make_session("a1", "old")],
                    observed_generation,
                )
                .await
            })
        };
        // The refresh has swapped memory and is paused before its persisted
        // rewrite.
        reached.wait().await;

        let mut newer = make_session("a1", "new");
        newer.status = SessionStatus::Active;
        newer.window_count = 7;
        let mut update = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move { reg.update_session(newer).await })
        };
        let early = tokio::time::timeout(std::time::Duration::from_millis(50), &mut update).await;
        assert!(
            early.is_err(),
            "a live report must not interleave the refresh's persisted rewrite"
        );

        release.wait().await;
        let removed = refresh.await.expect("refresh task");
        assert!(removed.is_empty());
        update.await.expect("update task");

        let row = reg
            .db
            .get_session("a1:new")
            .await
            .expect("read row")
            .expect("newer report persisted after the projection");
        assert_eq!(row.status, "active");
        assert_eq!(row.window_count, 7);

        let reloaded = SessionRegistry::new(Arc::clone(&reg.db));
        reloaded.load_from_db().await;
        let persisted = reloaded
            .get("a1:new")
            .await
            .expect("newer report survives reload");
        assert_eq!(persisted.status, SessionStatus::Active);
        assert_eq!(persisted.window_count, 7);

        eprintln!(
            "#2874 SC-01 serialization measured: observed_generation={observed_generation} removed={} persisted_status={} persisted_windows={} reload_windows={}",
            removed.len(),
            row.status,
            row.window_count,
            persisted.window_count
        );
    }

    /// #2874 SC-02: an ordinary refresh (no concurrent report) still removes
    /// obsolete Sessions and persists the replacement, without touching
    /// another Agent's Sessions.
    #[tokio::test]
    async fn sc02_an_ordinary_refresh_replaces_only_its_agent_and_survives_reload() {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        let reg = SessionRegistry::new(Arc::clone(&db));
        reg.update_session(make_session("a1", "old1")).await;
        reg.update_session(make_session("a1", "old2")).await;
        reg.update_session(make_session("a2", "keep")).await;

        let mut removed = replace(&reg, "a1", vec![make_session("a1", "replacement")]).await;
        removed.sort();
        assert_eq!(removed, vec!["a1:old1", "a1:old2"]);
        assert_eq!(sorted_ids(&reg).await, vec!["a1:replacement", "a2:keep"]);

        let reloaded = SessionRegistry::new(Arc::clone(&reg.db));
        reloaded.load_from_db().await;
        assert_eq!(
            sorted_ids(&reloaded).await,
            vec!["a1:replacement", "a2:keep"],
            "the replacement is durable and the other Agent is untouched"
        );

        eprintln!(
            "#2874 SC-02 measured: removed={removed:?} live={:?} reloaded={:?}",
            sorted_ids(&reg).await,
            sorted_ids(&reloaded).await
        );
    }
}
