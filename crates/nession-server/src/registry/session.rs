use crate::db::Database;
use chrono::{DateTime, Utc};
use nession_protocol::contracts::session::v1::{SessionActivityView, SessionMetadataAvailability};
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
    /// Bounded work-context summary the owning Agent reported with the current
    /// incarnation (#4007). In memory only, like `foreground_command`: the
    /// Agent re-reports it on the next inventory, and `unavailable` is a
    /// distinct state from a confirmed-empty revision 0.
    pub metadata: Option<SessionMetadataAvailability>,
    /// Capability-reported Session Activity (#3804).
    ///
    /// In memory only, like `foreground_command`: the Agent re-reports it after
    /// a reconnect, so persisting it would add write churn for a fact that is
    /// only meaningful while the Agent is connected. Absence means unknown, not
    /// idle.
    pub activity: Option<SessionActivityView>,
    /// The Agent process epoch that produced `activity`.
    ///
    /// A fence only: a restarted Agent has a new epoch and may restart its
    /// generation at 1 without being read as stale.
    pub activity_epoch: Option<String>,
    /// Monotonic generation of `activity` within `activity_epoch`.
    pub activity_generation: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionStatus {
    Active,
    Detached,
    Recovering,
    Orphaned,
    Zombie,
}

/// One live Session→Project membership as the Web read model sees it (#4234).
///
/// `revision` is the token a client echoes as `expected_revision`. It belongs
/// to one Session incarnation; the projection omits a binding that does not
/// match the Session's current durable instance, and an unassociated Session
/// (absent or tombstone) has no entry at all — its token is `0`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionProjectMembership {
    pub project_id: String,
    pub revision: u64,
}

/// The bound on Activity levels held for Sessions whose inventory row has not
/// been admitted yet (#4291).
///
/// One slot per `(Session, incarnation)`, and a hard total: a level held for an
/// unknown row is a reconciliation fallback, not a second registry. At the
/// bound a *new* key is refused (the Agent's full re-sync restates every level
/// after its inventory, so a refused hold is recoverable); a key already held
/// keeps its slot and is superseded by a newer fenced level, exactly the
/// coalescing rule the Agent's outbox states for its own lanes.
const PENDING_ACTIVITY_LIMIT: usize = 256;

/// One Activity level that arrived before its Session's authoritative inventory
/// row (#4291).
///
/// The Agent enqueues a new Session's inventory before its Activity level, but
/// a level can still reach the Server first (a frame already in flight, or an
/// older Agent). Rather than losing it until the next workload change or
/// reconnect, the registry holds it here and applies it — under the same
/// incarnation/epoch/generation fences — when the authoritative inventory
/// admits the row. Keyed by `(session_id, instance_id)` so a level observed for
/// one incarnation can never be applied to another.
struct PendingActivity {
    agent_id: String,
    epoch: String,
    generation: u64,
    activity: SessionActivityView,
}

pub struct SessionRegistry {
    sessions: Arc<RwLock<HashMap<String, SessionInfo>>>,
    /// Activity levels awaiting their Session's first inventory admission
    /// (#4291). Decided under the same Agent/lifecycle guards and the sessions
    /// write lock as the admission itself, so a hold and its replay cannot
    /// interleave with a newer report.
    pending_activity: Mutex<HashMap<(String, String), PendingActivity>>,
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
            pending_activity: Mutex::new(HashMap::new()),
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
    ///
    /// Each entry carries the binding revision the client must echo as
    /// `expected_revision` (#4234). An unassociated Session has no entry: its
    /// token is the protocol's unassociated `0`, which the projection layer
    /// supplies.
    pub async fn project_memberships_for(
        &self,
        sessions: &[SessionInfo],
    ) -> HashMap<String, SessionProjectMembership> {
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
                    matches_incarnation.then_some((
                        binding.session_id,
                        SessionProjectMembership {
                            project_id: binding.project_id,
                            revision: binding.revision,
                        },
                    ))
                })
                .collect(),
            Err(e) => {
                tracing::error!("Failed to read session project bindings: {e:#}");
                HashMap::new()
            }
        }
    }

    /// All live Sessions with their Project membership.
    pub async fn project_memberships(&self) -> HashMap<String, SessionProjectMembership> {
        let sessions = self.list().await;
        self.project_memberships_for(&sessions).await
    }

    pub async fn update_session(&self, mut session: SessionInfo) {
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
            if let Some(previous) = sessions.get(&session.session_id) {
                // An inventory update carries no Activity. A same-incarnation
                // replacement must not erase a level a newer Activity report
                // already committed (#3804).
                preserve_activity(previous, &mut session);
                // The same rule for the metadata summary (#4007): an inventory
                // frame that carries no summary (a legacy Agent, or one that
                // does not report it) must not erase the last answer for the
                // same incarnation.
                preserve_metadata(previous, &mut session);
            }
            // This is the authoritative admission of the row: apply an Activity
            // level that arrived before it (#4291), under the same fences, so
            // the first projection the Server serves already carries the
            // Agent's level.
            self.apply_pending_activity(&mut session);
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

    /// Apply one Session Activity level from the authoritative Agent connection.
    ///
    /// Returns `true` only when the level became the current projection.
    /// Refusals are the fence, not errors: a level for another incarnation, or
    /// one that is not newer than the stored `(epoch, generation)`, is silently
    /// ignored so a stale socket or a retried frame cannot resurrect Activity.
    ///
    /// A level whose Session row does not exist yet is **held**, not lost
    /// (#4291): the authoritative inventory admission replays it under the same
    /// fences, so an Activity frame delivered before its inventory converges
    /// without waiting for a workload change or a reconnect. A held level is
    /// not the current projection, so this still returns `false` for it.
    ///
    /// Activity is **not** Session interaction recency: `last_activity` and the
    /// Agent's session-state generation are deliberately untouched.
    pub async fn update_activity(
        &self,
        agent_id: &str,
        session_name: &str,
        instance_id: &str,
        epoch: &str,
        generation: u64,
        activity: SessionActivityView,
    ) -> bool {
        let session_id = format!("{agent_id}:{session_name}");
        // Serialized with the inventory replacement for this Agent and this
        // Session, so a force-refresh cannot interleave with the commit.
        let _agent = self.agent_guard(agent_id).await;
        let _lifecycle = self.lifecycle_guard(&session_id).await;

        let mut sessions = self.sessions.write().await;
        let Some(session) = sessions.get_mut(&session_id) else {
            return self.hold_pending_activity(
                agent_id,
                &session_id,
                instance_id,
                epoch,
                generation,
                activity,
            );
        };
        if session.instance_id.as_deref() != Some(instance_id) {
            return false;
        }
        if session.activity_epoch.as_deref() == Some(epoch)
            && generation <= session.activity_generation
        {
            return false;
        }
        session.activity = Some(activity);
        session.activity_epoch = Some(epoch.to_string());
        session.activity_generation = generation;
        true
    }

    /// Hold one level whose Session row has not been admitted yet (#4291).
    ///
    /// The hold is fenced exactly like a live commit: within one
    /// `(Session, incarnation, epoch)` a generation that is not newer is
    /// refused, and a new epoch may restart the counter. The slot is a level,
    /// so a newer fenced observation supersedes the held one. At
    /// [`PENDING_ACTIVITY_LIMIT`] a new key is refused rather than evicting a
    /// held level; the Agent's full re-sync restates levels after inventory, so
    /// a refusal is recoverable. Always returns `false`: a held level is not
    /// yet the Web-visible projection.
    fn hold_pending_activity(
        &self,
        agent_id: &str,
        session_id: &str,
        instance_id: &str,
        epoch: &str,
        generation: u64,
        activity: SessionActivityView,
    ) -> bool {
        let mut pending = self
            .pending_activity
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let key = (session_id.to_string(), instance_id.to_string());
        if let Some(held) = pending.get(&key) {
            if held.epoch == epoch && generation <= held.generation {
                return false;
            }
        } else if pending.len() >= PENDING_ACTIVITY_LIMIT {
            return false;
        }
        pending.insert(
            key,
            PendingActivity {
                agent_id: agent_id.to_string(),
                epoch: epoch.to_string(),
                generation,
                activity,
            },
        );
        false
    }

    /// Decide the held levels for a Session the authoritative inventory is
    /// admitting (#4291). Called under the sessions write lock.
    ///
    /// Only a level held for the **exact admitted incarnation** can apply, and
    /// it still passes the live `(epoch, generation)` fence — a level already
    /// committed for the same incarnation (preserved onto this row) wins over
    /// an older hold. Every other hold for this Session is decided too: the
    /// authoritative row now states the current incarnation, so a level
    /// observed for another one is stale and is dropped, never inherited. A
    /// legacy row with no instance identity cannot prove any hold and drops
    /// them all.
    fn apply_pending_activity(&self, session: &mut SessionInfo) {
        let mut pending = self
            .pending_activity
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let matching = session
            .instance_id
            .as_ref()
            .and_then(|instance| pending.remove(&(session.session_id.clone(), instance.clone())));
        pending.retain(|(sid, _), _| sid != &session.session_id);
        let Some(held) = matching else {
            return;
        };
        if session.activity_epoch.as_deref() == Some(held.epoch.as_str())
            && held.generation <= session.activity_generation
        {
            return;
        }
        session.activity = Some(held.activity);
        session.activity_epoch = Some(held.epoch);
        session.activity_generation = held.generation;
    }

    /// Drop every held level for a Session that is leaving the registry.
    /// A removed Session has no projection; a later same-name report is a new
    /// observation and must not inherit a level held for the old row.
    fn discard_pending_activity(&self, session_id: &str) {
        let mut pending = self
            .pending_activity
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        pending.retain(|(sid, _), _| sid != session_id);
    }

    /// Register only the create-time placeholder, without overwriting an
    /// authoritative Agent report that may have raced ahead of the command
    /// acknowledgement (#2021). The presence check and insert MUST share
    /// one write lock: `get()` followed by `update_session()` would recreate
    /// the same read/insert race.
    ///
    /// Return false when the row already exists; creation still succeeded,
    /// and the caller may broadcast the existing authoritative row.
    ///
    /// A placeholder does not decide held Activity levels (#4291): it carries
    /// no verified incarnation, so a hold waits for the authoritative Agent
    /// report that admits the row.
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
        self.discard_pending_activity(session_id);
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
    /// Binding. A reclaim that does not delete the persisted row restores the
    /// removed in-memory entry, so a failed conditional DELETE can never hide
    /// a still-durable Session from the live Session list (#4166).
    pub(crate) async fn reclaim_stale_recovering_under_lock(
        &self,
        agent_id: &str,
        session_id: &str,
        cutoff: i64,
    ) -> bool {
        // The live registry is the authority: a restore writes the fresh
        // status and activity here before its persisted write completes.
        // Keep the removed projection so a failed DELETE can put it back.
        let removed_from_memory = {
            let mut sessions = self.sessions.write().await;
            match sessions.get(session_id) {
                Some(current)
                    if current.status != SessionStatus::Recovering
                        || current.last_activity.timestamp() >= cutoff =>
                {
                    return false;
                }
                Some(current) => {
                    let removed = current.clone();
                    sessions.remove(session_id);
                    Some(removed)
                }
                // A persisted row with no in-memory entry (for example after
                // a restart that has not loaded it) is decided by the row.
                None => None,
            }
        };

        match self
            .db
            .delete_recovering_session_before(session_id, cutoff)
            .await
        {
            Ok(true) => {
                self.discard_pending_activity(session_id);
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
                if removed_from_memory.is_some() {
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
                // The conditional DELETE did not run, so the persisted row is
                // still the stale recovering Session. Restore the in-memory
                // entry we removed above instead of serving a Session list
                // that has lost a Session SQLite still holds (#4166). The
                // snapshot is used because a database error is exactly when a
                // reload would fail too; a concurrent writer that re-projected
                // this Session keeps its newer entry.
                if let Some(removed) = removed_from_memory {
                    let mut sessions = self.sessions.write().await;
                    sessions.entry(session_id.to_string()).or_insert(removed);
                }
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
        // A disconnected or deleted Agent's held levels leave with its rows:
        // the reconnect re-sync restates inventory and Activity together.
        self.pending_activity
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|_, held| held.agent_id != agent_id);
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
        mut incoming: Vec<SessionInfo>,
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
            // The force-refresh reply carries the Session inventory, not its
            // ephemeral Activity. Carry forward the level already committed for
            // the same incarnation, so a refresh cannot clear a newer
            // observation (#3804).
            for session in &mut incoming {
                if let Some(previous) = sessions.get(&session.session_id) {
                    preserve_activity(previous, session);
                    // The same rule for the metadata summary (#4405): an
                    // inventory-only refresh carries no replacement answer,
                    // so the last summary for the same incarnation must
                    // survive the bulk swap exactly as in `update_session`.
                    preserve_metadata(previous, session);
                }
                // The refresh is an authoritative admission too: a level held
                // for an incoming Session applies under the same fences, and
                // holds for other incarnations of it are decided (#4291).
                self.apply_pending_activity(session);
            }
            let incoming_ids: std::collections::HashSet<&str> =
                incoming.iter().map(|s| s.session_id.as_str()).collect();
            let removed: Vec<String> = sessions
                .values()
                .filter(|s| s.agent_id == agent_id && !incoming_ids.contains(s.session_id.as_str()))
                .map(|s| s.session_id.clone())
                .collect();
            sessions.retain(|_, s| s.agent_id != agent_id);
            for session in &incoming {
                sessions.insert(session.session_id.clone(), session.clone());
            }
            // The snapshot is authoritative for the Agent's whole Session set:
            // every incoming Session's holds were decided above, and a hold for
            // any other Session of this Agent names a Session the report says
            // does not exist — it is stale, whether or not a row was removed.
            self.pending_activity
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .retain(|_, held| held.agent_id != agent_id);
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
        // Summaries are live Agent answers and are re-reported; a recovered
        // row is unknown rather than a guessed empty task (#4007).
        metadata: None,
        // Ephemeral Activity is not persisted either; the Agent re-reports it
        // from its own coordinator after a restart or reconnect.
        activity: None,
        activity_epoch: None,
        activity_generation: 0,
        created_at,
        last_activity,
    }
}

/// Carry an ephemeral Activity level onto a same-incarnation inventory row.
///
/// A different incarnation is a different Session and must inherit nothing; a
/// missing previous instance id is a legacy row and cannot be proven the same.
fn preserve_activity(previous: &SessionInfo, next: &mut SessionInfo) {
    if previous.instance_id.is_some() && previous.instance_id == next.instance_id {
        next.activity = previous.activity.clone();
        next.activity_epoch = previous.activity_epoch.clone();
        next.activity_generation = previous.activity_generation;
    }
}

/// Keep the last metadata summary for the same incarnation.
///
/// A summary is only meaningful for the instance it described, so a
/// same-name replacement never inherits it; the successor reports its own.
fn preserve_metadata(previous: &SessionInfo, next: &mut SessionInfo) {
    if next.metadata.is_none()
        && previous.instance_id.is_some()
        && previous.instance_id == next.instance_id
    {
        next.metadata = previous.metadata.clone();
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
            metadata: None,
            activity: None,
            activity_epoch: None,
            activity_generation: 0,
            created_at: Utc::now(),
            last_activity: Utc::now(),
        }
    }

    fn activity(state: &str) -> SessionActivityView {
        SessionActivityView {
            state: state.to_string(),
            attention: None,
            capability_id: Some("shell".to_string()),
            observed_at_ms: 1_700_000_000_000,
        }
    }

    async fn session_with_instance(reg: &SessionRegistry, instance: &str) -> SessionInfo {
        let mut session = make_session("a1", "dev");
        session.instance_id = Some(instance.to_string());
        reg.update_session(session.clone()).await;
        session
    }

    #[tokio::test]
    async fn activity_is_fenced_by_incarnation_epoch_and_generation() {
        let reg = new_registry().await;
        session_with_instance(&reg, "inc-1").await;
        let before = reg.get("a1:dev").await.unwrap().last_activity;

        assert!(
            reg.update_activity("a1", "dev", "inc-1", "epoch-1", 1, activity("working"))
                .await
        );
        // A duplicate level and an older generation are refused in the same
        // epoch; a new Agent process epoch may restart the counter.
        assert!(
            !reg.update_activity("a1", "dev", "inc-1", "epoch-1", 1, activity("idle"))
                .await
        );
        assert!(
            !reg.update_activity("a1", "dev", "inc-1", "epoch-1", 0, activity("idle"))
                .await
        );
        assert!(
            reg.update_activity("a1", "dev", "inc-1", "epoch-1", 2, activity("idle"))
                .await
        );
        assert!(
            !reg.update_activity("a1", "dev", "inc-1", "epoch-1", 2, activity("working"))
                .await
        );
        assert!(
            reg.update_activity("a1", "dev", "inc-1", "epoch-2", 1, activity("working"))
                .await
        );
        // Another incarnation of the same name inherits nothing.
        assert!(
            !reg.update_activity("a1", "dev", "inc-2", "epoch-2", 9, activity("idle"))
                .await
        );

        let stored = reg.get("a1:dev").await.unwrap();
        assert_eq!(stored.activity.unwrap().state, "working");
        assert_eq!(stored.activity_epoch.as_deref(), Some("epoch-2"));
        assert_eq!(
            stored.last_activity, before,
            "activity is not Session interaction recency"
        );
    }

    #[tokio::test]
    async fn inventory_updates_and_force_refresh_preserve_same_incarnation_activity() {
        let reg = new_registry().await;
        let first = session_with_instance(&reg, "inc-1").await;
        assert!(
            reg.update_activity("a1", "dev", "inc-1", "epoch-1", 1, activity("working"))
                .await
        );

        // A normal inventory update (which never carries activity).
        reg.update_session(first.clone()).await;
        assert_eq!(
            reg.get("a1:dev").await.unwrap().activity.unwrap().state,
            "working"
        );

        // A force refresh replaces the whole Agent set from the inventory.
        replace(&reg, "a1", vec![first]).await;
        assert_eq!(
            reg.get("a1:dev").await.unwrap().activity.unwrap().state,
            "working"
        );

        // A recreated same-name Session starts with no activity.
        let mut replacement = make_session("a1", "dev");
        replacement.instance_id = Some("inc-2".to_string());
        reg.update_session(replacement.clone()).await;
        assert!(reg.get("a1:dev").await.unwrap().activity.is_none());
        replace(&reg, "a1", vec![replacement]).await;
        assert!(reg.get("a1:dev").await.unwrap().activity.is_none());
    }

    /// #4405: the bulk force-refresh admission must preserve the last
    /// same-incarnation metadata summary exactly like `update_session` does;
    /// an inventory-only row carries no replacement answer. A different
    /// incarnation never inherits the predecessor's summary.
    #[tokio::test]
    async fn force_refresh_preserves_same_incarnation_metadata_summary() {
        use nession_protocol::contracts::session::v1::{
            SessionMetadataState, SessionMetadataSummary,
        };
        let reg = new_registry().await;
        let mut first = make_session("a1", "dev");
        first.instance_id = Some("inc-1".to_string());
        first.metadata = Some(SessionMetadataAvailability::available(
            SessionMetadataSummary {
                revision: 3,
                title: Some("work context".to_string()),
                tags: vec!["ship".to_string()],
            },
        ));
        reg.update_session(first).await;
        let expected = reg.get("a1:dev").await.unwrap().metadata.unwrap();
        assert_eq!(expected.state, SessionMetadataState::Available);

        // An inventory-only force refresh: same incarnation, no metadata.
        let mut refreshed = make_session("a1", "dev");
        refreshed.instance_id = Some("inc-1".to_string());
        refreshed.metadata = None;
        replace(&reg, "a1", vec![refreshed.clone()]).await;
        assert_eq!(
            reg.get("a1:dev").await.unwrap().metadata,
            Some(expected.clone()),
            "a force refresh must not clear the same-incarnation summary"
        );

        // A repeated refresh must not erode the preserved summary either.
        replace(&reg, "a1", vec![refreshed]).await;
        assert_eq!(
            reg.get("a1:dev").await.unwrap().metadata,
            Some(expected.clone())
        );

        // The normal single-row path keeps the same preservation semantics.
        let mut again = make_session("a1", "dev");
        again.instance_id = Some("inc-1".to_string());
        again.metadata = None;
        reg.update_session(again).await;
        assert_eq!(reg.get("a1:dev").await.unwrap().metadata, Some(expected));

        // A recreated same-name Session never inherits the predecessor's
        // answer; the successor reports its own.
        let mut successor = make_session("a1", "dev");
        successor.instance_id = Some("inc-2".to_string());
        successor.metadata = None;
        replace(&reg, "a1", vec![successor]).await;
        assert!(reg.get("a1:dev").await.unwrap().metadata.is_none());
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

    /// #4291: a level delivered before its inventory row is applied at the
    /// authoritative admission — the same fences, no workload change and no
    /// reconnect. Before the fix the level was refused and the row admitted
    /// without it, leaving the Session `unknown` indefinitely.
    #[tokio::test]
    async fn a_level_arriving_before_its_row_is_applied_at_inventory_admission() {
        let reg = new_registry().await;
        // Activity first: the row does not exist. The level is held, not yet
        // the projection, so no broadcast-worthy change is reported.
        assert!(
            !reg.update_activity("a1", "dev", "inc-1", "epoch-1", 1, activity("working"))
                .await
        );
        assert!(reg.get("a1:dev").await.is_none());

        let mut row = make_session("a1", "dev");
        row.instance_id = Some("inc-1".to_string());
        let admitted_recency = row.last_activity;
        reg.update_session(row).await;

        let stored = reg.get("a1:dev").await.unwrap();
        assert_eq!(
            stored.activity.unwrap().state,
            "working",
            "the admission replays the held level"
        );
        assert_eq!(stored.activity_epoch.as_deref(), Some("epoch-1"));
        assert_eq!(stored.activity_generation, 1);
        assert_eq!(
            stored.last_activity, admitted_recency,
            "the replay is not Session interaction recency"
        );

        // The hold was consumed: a same-incarnation inventory update preserves
        // the applied level, and the live fence still refuses older frames.
        let mut again = make_session("a1", "dev");
        again.instance_id = Some("inc-1".to_string());
        reg.update_session(again).await;
        assert_eq!(
            reg.get("a1:dev").await.unwrap().activity.unwrap().state,
            "working"
        );
        assert!(
            !reg.update_activity("a1", "dev", "inc-1", "epoch-1", 1, activity("idle"))
                .await
        );
    }

    /// A held level is fenced exactly like a live one: generation and epoch
    /// order the hold, and a level held for another incarnation can never be
    /// applied to the admitted row.
    #[tokio::test]
    async fn a_held_level_is_fenced_by_incarnation_epoch_and_generation() {
        let reg = new_registry().await;
        // Same epoch: only a newer generation supersedes the hold; duplicates
        // and older generations are refused.
        assert!(
            !reg.update_activity("a1", "dev", "inc-1", "epoch-1", 2, activity("idle"))
                .await
        );
        assert!(
            !reg.update_activity("a1", "dev", "inc-1", "epoch-1", 1, activity("working"))
                .await
        );
        assert!(
            !reg.update_activity("a1", "dev", "inc-1", "epoch-1", 2, activity("working"))
                .await
        );
        // A new Agent epoch may restart the counter at 1.
        assert!(
            !reg.update_activity("a1", "dev", "inc-1", "epoch-2", 1, activity("working"))
                .await
        );
        // Another incarnation holds its own slot; it cannot supersede inc-1's.
        assert!(
            !reg.update_activity("a1", "dev", "inc-2", "epoch-2", 9, activity("idle"))
                .await
        );

        let mut row = make_session("a1", "dev");
        row.instance_id = Some("inc-1".to_string());
        reg.update_session(row).await;
        let stored = reg.get("a1:dev").await.unwrap();
        assert_eq!(stored.activity.unwrap().state, "working");
        assert_eq!(stored.activity_epoch.as_deref(), Some("epoch-2"));
        assert_eq!(stored.activity_generation, 1);

        // The stale-incarnation hold was decided at admission and dropped: a
        // later inc-2 frame is refused by the live fence, and an authoritative
        // inc-2 replacement inherits nothing.
        assert!(
            !reg.update_activity("a1", "dev", "inc-2", "epoch-2", 10, activity("idle"))
                .await
        );
        let mut replacement = make_session("a1", "dev");
        replacement.instance_id = Some("inc-2".to_string());
        reg.update_session(replacement).await;
        assert!(reg.get("a1:dev").await.unwrap().activity.is_none());
    }

    /// The hold is bounded: at the limit a new key is refused rather than
    /// evicting a held level, a held key keeps its slot and is still superseded
    /// by a newer fenced level, and a refused hold is never stored.
    #[tokio::test]
    async fn held_levels_are_bounded_and_a_refused_hold_is_not_stored() {
        let reg = new_registry().await;
        for n in 0..PENDING_ACTIVITY_LIMIT {
            assert!(
                !reg.update_activity(
                    "a1",
                    &format!("s{n}"),
                    "inc-1",
                    "epoch-1",
                    1,
                    activity("working")
                )
                .await
            );
        }
        // A new key at the bound is refused...
        assert!(
            !reg.update_activity(
                "a1",
                "one-too-many",
                "inc-1",
                "epoch-1",
                1,
                activity("working")
            )
            .await
        );
        let mut refused = make_session("a1", "one-too-many");
        refused.instance_id = Some("inc-1".to_string());
        reg.update_session(refused).await;
        assert!(
            reg.get("a1:one-too-many").await.unwrap().activity.is_none(),
            "a refused hold must not be stored"
        );
        // ...while a held key keeps its slot and is still a level: a newer
        // generation supersedes it even at the bound.
        assert!(
            !reg.update_activity("a1", "s0", "inc-1", "epoch-1", 2, activity("idle"))
                .await
        );
        let mut first = make_session("a1", "s0");
        first.instance_id = Some("inc-1".to_string());
        reg.update_session(first).await;
        let stored = reg.get("a1:s0").await.unwrap();
        assert_eq!(stored.activity.unwrap().state, "idle");
        assert_eq!(stored.activity_generation, 2);
    }

    /// A removed Session has no projection to hold for: a gone report and an
    /// Agent wipe both decide the holds, and a later same-name report is a new
    /// observation that inherits nothing.
    #[tokio::test]
    async fn removal_and_agent_wipe_clear_held_levels() {
        let reg = new_registry().await;
        for (agent, name) in [("a1", "dev"), ("a1", "api"), ("a2", "other")] {
            assert!(
                !reg.update_activity(agent, name, "inc-1", "epoch-1", 1, activity("working"))
                    .await
            );
        }

        // A gone report for a row that was never admitted decides the hold.
        reg.remove("a1:dev").await;
        let mut dev = make_session("a1", "dev");
        dev.instance_id = Some("inc-1".to_string());
        reg.update_session(dev).await;
        assert!(reg.get("a1:dev").await.unwrap().activity.is_none());

        // An Agent wipe takes its holds with it, leaving other Agents untouched.
        reg.remove_by_agent("a1").await;
        let mut api = make_session("a1", "api");
        api.instance_id = Some("inc-1".to_string());
        reg.update_session(api).await;
        assert!(reg.get("a1:api").await.unwrap().activity.is_none());
        let mut other = make_session("a2", "other");
        other.instance_id = Some("inc-1".to_string());
        reg.update_session(other).await;
        assert_eq!(
            reg.get("a2:other").await.unwrap().activity.unwrap().state,
            "working"
        );
    }

    /// A force-refresh is an authoritative admission too: holds for incoming
    /// Sessions apply under the same fences, and a hold for a Session the
    /// snapshot says does not exist is stale and dropped.
    #[tokio::test]
    async fn a_force_refresh_applies_holds_for_incoming_sessions_and_drops_absent_ones() {
        let reg = new_registry().await;
        assert!(
            !reg.update_activity("a1", "keep", "inc-1", "epoch-1", 1, activity("working"))
                .await
        );
        assert!(
            !reg.update_activity("a1", "absent", "inc-1", "epoch-1", 1, activity("working"))
                .await
        );

        let mut keep = make_session("a1", "keep");
        keep.instance_id = Some("inc-1".to_string());
        let removed = replace(&reg, "a1", vec![keep]).await;
        assert!(removed.is_empty());
        assert_eq!(
            reg.get("a1:keep").await.unwrap().activity.unwrap().state,
            "working"
        );

        let mut absent = make_session("a1", "absent");
        absent.instance_id = Some("inc-1".to_string());
        reg.update_session(absent).await;
        assert!(
            reg.get("a1:absent").await.unwrap().activity.is_none(),
            "a hold for a Session absent from the authoritative snapshot must not survive"
        );
    }

    /// A create-time placeholder carries no verified incarnation, so it does
    /// not decide a hold; the authoritative Agent report does.
    #[tokio::test]
    async fn a_create_placeholder_does_not_decide_a_held_level() {
        let reg = new_registry().await;
        assert!(
            !reg.update_activity("a1", "dev", "inc-1", "epoch-1", 1, activity("working"))
                .await
        );
        assert!(
            reg.insert_session_if_absent(make_session("a1", "dev"))
                .await
        );
        assert!(reg.get("a1:dev").await.unwrap().activity.is_none());

        let mut row = make_session("a1", "dev");
        row.instance_id = Some("inc-1".to_string());
        reg.update_session(row).await;
        assert_eq!(
            reg.get("a1:dev").await.unwrap().activity.unwrap().state,
            "working"
        );
    }

    /// A legacy row with no instance identity cannot prove any held level's
    /// incarnation: the holds are dropped, never guessed onto the row, and a
    /// later authoritative report does not resurrect them.
    #[tokio::test]
    async fn a_legacy_admission_cannot_prove_a_held_level_and_drops_it() {
        let reg = new_registry().await;
        assert!(
            !reg.update_activity("a1", "dev", "inc-1", "epoch-1", 1, activity("working"))
                .await
        );
        reg.update_session(make_session("a1", "dev")).await;
        assert!(reg.get("a1:dev").await.unwrap().activity.is_none());

        let mut row = make_session("a1", "dev");
        row.instance_id = Some("inc-1".to_string());
        reg.update_session(row).await;
        assert!(reg.get("a1:dev").await.unwrap().activity.is_none());
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

    /// #3399: an authoritative update for the same recyclable Session id
    /// replaces the durable instance identity, and the new incarnation must not
    /// inherit the previous Project membership.
    ///
    /// The Agent-side watcher regression proves the replacement is published on
    /// the `instance_id` payload field; this is the Server half of the seam.
    #[tokio::test]
    async fn an_authoritative_replacement_updates_the_registry_and_drops_the_old_project_binding() {
        let reg = new_registry().await;
        let now = Utc::now().timestamp();
        reg.db
            .upsert_session_project_binding(&crate::db::SessionProjectBindingRow {
                session_id: "a1:dev".to_owned(),
                agent_id: "a1".to_owned(),
                project_id: "project-1".to_owned(),
                incarnation_id: "instance-a".to_owned(),
                agent_created_at: now,
                revision: 1,
                updated_at: now,
            })
            .await
            .expect("seed the previous incarnation's Project binding");

        let mut first = make_session("a1", "dev");
        first.instance_id = Some("instance-a".to_owned());
        reg.update_session(first).await;

        let mut replacement = make_session("a1", "dev");
        replacement.instance_id = Some("instance-b".to_owned());
        reg.update_session(replacement).await;

        let stored = reg.get("a1:dev").await.expect("session present");
        assert_eq!(
            stored.instance_id.as_deref(),
            Some("instance-b"),
            "the authoritative report must replace the previous incarnation"
        );
        assert!(
            reg.db
                .get_session_project_binding("a1:dev")
                .await
                .expect("read the binding")
                .is_none(),
            "a new incarnation must not inherit the previous Project membership"
        );
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
