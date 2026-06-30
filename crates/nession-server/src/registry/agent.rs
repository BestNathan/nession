use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use chrono::{DateTime, Utc};
use nession_common::protocol::AgentMetadata;

#[derive(Debug, Clone)]
pub struct AgentInfo {
    pub agent_id: String,
    pub hostname: String,
    pub ip_address: String,
    pub port: u16,
    /// Public WebSocket URL clients use to connect to this agent.
    /// When `None`, the server constructs `ws://{ip_address}:{port}`.
    pub connect_url: Option<String>,
    pub registered_at: DateTime<Utc>,
    pub last_heartbeat: DateTime<Utc>,
    pub status: AgentStatus,
    pub metadata: AgentMetadata,
    pub session_count: u32,
    pub active_sessions: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentStatus {
    Online,
    Offline,
    Degraded,
}

pub struct AgentRegistry {
    agents: Arc<RwLock<HashMap<String, AgentInfo>>>,
    heartbeat_timeout_secs: u64,
}

impl AgentRegistry {
    pub fn new(heartbeat_timeout_secs: u64) -> Self {
        Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
            heartbeat_timeout_secs,
        }
    }

    pub async fn register(&self, info: AgentInfo) {
        let mut agents = self.agents.write().await;
        agents.insert(info.agent_id.clone(), info);
    }

    pub async fn update_heartbeat(&self, agent_id: &str, session_count: u32, active_sessions: u32) {
        let mut agents = self.agents.write().await;
        if let Some(agent) = agents.get_mut(agent_id) {
            agent.last_heartbeat = Utc::now();
            agent.status = AgentStatus::Online;
            agent.session_count = session_count;
            agent.active_sessions = active_sessions;
        }
    }

    pub async fn get(&self, agent_id: &str) -> Option<AgentInfo> {
        let agents = self.agents.read().await;
        agents.get(agent_id).cloned()
    }

    pub async fn list(&self) -> Vec<AgentInfo> {
        let agents = self.agents.read().await;
        agents.values().cloned().collect()
    }

    pub async fn check_offline_agents(&self) -> Vec<String> {
        let mut agents = self.agents.write().await;
        let now = Utc::now();
        let mut offline = vec![];

        for (agent_id, agent) in agents.iter_mut() {
            if agent.status == AgentStatus::Online {
                let elapsed = (now - agent.last_heartbeat).num_seconds() as u64;
                if elapsed > self.heartbeat_timeout_secs {
                    agent.status = AgentStatus::Offline;
                    offline.push(agent_id.clone());
                }
            }
        }

        offline
    }

    pub async fn unregister(&self, agent_id: &str) {
        let mut agents = self.agents.write().await;
        agents.remove(agent_id);
    }
}
