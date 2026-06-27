use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: String,
    pub agent_id: String,
    pub session_name: String,
    pub status: SessionStatus,
    pub window_count: u32,
    pub attached_clients: u32,
    pub last_activity: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionStatus {
    Active,
    Detached,
    Zombie,
}

pub struct SessionRegistry {
    sessions: Arc<RwLock<HashMap<String, SessionInfo>>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn update_session(&self, session: SessionInfo) {
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
        sessions.values()
            .filter(|s| s.agent_id == agent_id)
            .cloned()
            .collect()
    }

    pub async fn remove(&self, session_id: &str) {
        let mut sessions = self.sessions.write().await;
        sessions.remove(session_id);
    }

    pub async fn remove_by_agent(&self, agent_id: &str) {
        let mut sessions = self.sessions.write().await;
        sessions.retain(|_, s| s.agent_id != agent_id);
    }
}
