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
        let status_str = match session.status {
            SessionStatus::Active => "active",
            SessionStatus::Detached => "detached",
            SessionStatus::Recovering => "recovering",
            SessionStatus::Orphaned => "orphaned",
            SessionStatus::Zombie => "zombie",
        };

        // Write through to SQLite first, then update in-memory.
        // DB write failure is logged but does not block the in-memory update.
        if let Err(e) = self.db.insert_session(&session, status_str).await {
            tracing::error!("Failed to persist session {}: {:#}", session.session_id, e);
        }

        let mut sessions = self.sessions.write().await;
        sessions.insert(session.session_id.clone(), session);
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
            .keys()
            .filter(|k| sessions.get(*k).is_some_and(|s| s.agent_id == agent_id))
            .cloned()
            .collect();
        sessions.retain(|_, s| s.agent_id != agent_id);
        removed
    }
}
