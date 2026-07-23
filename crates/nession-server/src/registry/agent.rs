use crate::db::Database;
use chrono::{DateTime, Utc};
use nession_common::protocol::{
    AddressStatus, AgentAddress, AgentMetadata, NetworkType, ProbedAddress,
};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
pub struct AgentInfo {
    pub agent_id: String,
    pub hostname: String,
    pub ip_address: String,
    pub port: u16,
    /// Human-readable display name. Set via agent config or Web UI rename.
    /// When `None` the UI falls back to hostname.
    pub display_name: Option<String>,
    /// Public WebSocket URL clients use to connect to this agent.
    /// When `None`, the server constructs `ws://{ip_address}:{port}/ws`.
    pub connect_url: Option<String>,
    /// All advertised P2P endpoints with the server's latest probe status.
    /// Populated from the register payload (or synthesised from the legacy
    /// fields for old agents), then updated in place by the probe task.
    pub addresses: Vec<ProbedAddress>,
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
    db: Arc<Database>,
}

impl AgentRegistry {
    pub fn new(heartbeat_timeout_secs: u64, db: Arc<Database>) -> Self {
        Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
            heartbeat_timeout_secs,
            db,
        }
    }

    /// Restore agents persisted to SQLite. Their addresses are loaded with
    /// status reset to `Unknown` (the probe task re-establishes reachability),
    /// and status is `Offline` until the agent reconnects and re-registers.
    pub async fn load_from_db(&self) {
        match self.db.list_agents().await {
            Ok(rows) => {
                let mut agents = self.agents.write().await;
                for row in rows {
                    let registered_at =
                        DateTime::from_timestamp(row.registered_at, 0).unwrap_or_else(Utc::now);
                    let last_heartbeat =
                        DateTime::from_timestamp(row.last_heartbeat, 0).unwrap_or_else(Utc::now);
                    let metadata: AgentMetadata =
                        serde_json::from_str(&row.metadata).unwrap_or(AgentMetadata {
                            tmux_version: String::new(),
                            os_version: String::new(),
                            nession_version: String::new(),
                        });
                    let addresses = decode_addresses(&row.addresses);
                    let info = AgentInfo {
                        agent_id: row.agent_id.clone(),
                        hostname: row.hostname,
                        ip_address: row.ip_address,
                        port: row.port,
                        display_name: row.display_name,
                        connect_url: row.connect_url,
                        addresses,
                        registered_at,
                        last_heartbeat,
                        // Persisted agents start Offline until they reconnect.
                        status: AgentStatus::Offline,
                        metadata,
                        session_count: 0,
                        active_sessions: 0,
                    };
                    agents.insert(row.agent_id, info);
                }
                tracing::info!("Loaded {} agents from database", agents.len());
            }
            Err(e) => {
                tracing::error!("Failed to load agents from database: {:#}", e);
            }
        }
    }

    pub async fn register(&self, info: AgentInfo) {
        // Write-through to SQLite so addresses/connect_url survive restarts.
        let metadata_json =
            serde_json::to_string(&info.metadata).unwrap_or_else(|_| "{}".to_string());
        let addresses_json = encode_addresses(&info.addresses);
        if let Err(e) = self
            .db
            .insert_agent(crate::db::AgentInsert {
                agent_id: &info.agent_id,
                hostname: &info.hostname,
                ip_address: &info.ip_address,
                port: info.port,
                // Auth token hashing is handled elsewhere; agents are trusted
                // post-auth. Persist an empty hash placeholder for now.
                auth_token_hash: "",
                metadata: &metadata_json,
                display_name: info.display_name.as_deref(),
                connect_url: info.connect_url.as_deref(),
                addresses: &addresses_json,
            })
            .await
        {
            tracing::error!("Failed to persist agent {}: {:#}", info.agent_id, e);
        }

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

    /// Update agent metadata in memory (version, tmux, OS).
    /// Called on each heartbeat so the web UI stays current after agent upgrades.
    pub async fn update_metadata(&self, agent_id: &str, metadata: AgentMetadata) {
        let mut agents = self.agents.write().await;
        if let Some(agent) = agents.get_mut(agent_id) {
            agent.metadata = metadata;
        }
    }

    /// Update (or clear) the display name for an agent in memory and in the DB.
    /// Returns the updated AgentInfo, or None if the agent doesn't exist.
    pub async fn update_display_name(
        &self,
        agent_id: &str,
        display_name: Option<String>,
    ) -> Option<AgentInfo> {
        // Write-through to SQLite
        if let Err(e) = self
            .db
            .update_agent_display_name(agent_id, display_name.as_deref())
            .await
        {
            tracing::error!(
                "Failed to persist display_name for agent {}: {:#}",
                agent_id,
                e
            );
        }

        let mut agents = self.agents.write().await;
        if let Some(agent) = agents.get_mut(agent_id) {
            agent.display_name = display_name;
            Some(agent.clone())
        } else {
            None
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

    /// Snapshot of every (agent_id, address url) pair the probe task should
    /// dial. Cloned out so the probe runs without holding the registry lock.
    pub async fn list_probe_targets(&self) -> Vec<(String, Vec<String>)> {
        let agents = self.agents.read().await;
        agents
            .values()
            .map(|a| {
                (
                    a.agent_id.clone(),
                    a.addresses.iter().map(|p| p.address.url.clone()).collect(),
                )
            })
            .collect()
    }

    /// Record a probe result for one of an agent's addresses (matched by URL).
    /// No-op if the agent or address no longer exists (e.g. re-registered).
    pub async fn update_address_status(
        &self,
        agent_id: &str,
        url: &str,
        status: AddressStatus,
        rtt_ms: Option<u64>,
    ) {
        let mut agents = self.agents.write().await;
        if let Some(agent) = agents.get_mut(agent_id) {
            for probed in &mut agent.addresses {
                if probed.address.url == url {
                    probed.status = status;
                    probed.rtt_ms = rtt_ms;
                    break;
                }
            }
        }
    }

    pub async fn check_offline_agents(&self) -> Vec<String> {
        let mut agents = self.agents.write().await;
        let now = Utc::now();
        let mut offline = vec![];

        for (agent_id, agent) in agents.iter_mut() {
            if agent.status == AgentStatus::Online {
                let elapsed = (now - agent.last_heartbeat).num_seconds().unsigned_abs();
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

/// Encode an agent's addresses to the JSON persisted in SQLite. Only the
/// advertised address is stored (not probe status/rtt, which are volatile and
/// reset on restart).
fn encode_addresses(addresses: &[ProbedAddress]) -> String {
    let plain: Vec<&AgentAddress> = addresses.iter().map(|p| &p.address).collect();
    serde_json::to_string(&plain).unwrap_or_else(|_| "[]".to_string())
}

/// Decode the persisted addresses JSON back into `ProbedAddress` with status
/// reset to `Unknown`. Tolerates empty/malformed strings by returning empty.
fn decode_addresses(json: &str) -> Vec<ProbedAddress> {
    if json.trim().is_empty() {
        return Vec::new();
    }
    match serde_json::from_str::<Vec<AgentAddress>>(json) {
        Ok(addrs) => addrs
            .into_iter()
            .map(|address| ProbedAddress {
                address,
                status: AddressStatus::Unknown,
                rtt_ms: None,
            })
            .collect(),
        Err(e) => {
            tracing::warn!("Failed to decode persisted agent addresses: {e}");
            Vec::new()
        }
    }
}

/// Build the `ProbedAddress` list for a freshly-registered agent.
///
/// Uses the agent-supplied `addresses` when present; otherwise synthesises a
/// single-entry list from the legacy `ip_address`/`port`/`connect_url` fields
/// for backward compatibility with agents that predate multi-address support.
/// All entries start with `AddressStatus::Unknown`.
#[must_use]
pub fn build_probed_addresses(
    addresses: Vec<AgentAddress>,
    ip_address: &str,
    port: u16,
    connect_url: Option<&str>,
) -> Vec<ProbedAddress> {
    let base = if addresses.is_empty() {
        nession_common::address::legacy_to_addresses(ip_address, port, connect_url)
    } else {
        addresses
    };
    let (finalised, _dropped) = nession_common::address::finalize_addresses(base);
    finalised
        .into_iter()
        .map(|address| ProbedAddress {
            address,
            status: AddressStatus::Unknown,
            rtt_ms: None,
        })
        .collect()
}

/// Pick the legacy single `agent_address` for old clients from a probed list.
///
/// Prefers a tunnel (reachable from anywhere), then the first reachable entry,
/// then simply the first. Returns `None` when the list is empty (relay-only).
#[must_use]
pub fn legacy_agent_address(addresses: &[ProbedAddress]) -> Option<String> {
    addresses
        .iter()
        .find(|p| p.address.network_type == NetworkType::Tunnel)
        .or_else(|| {
            addresses
                .iter()
                .find(|p| p.status == AddressStatus::Reachable)
        })
        .or_else(|| addresses.first())
        .map(|p| p.address.url.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_probed(url: &str, network_type: NetworkType, status: AddressStatus) -> ProbedAddress {
        ProbedAddress {
            address: AgentAddress {
                url: url.to_string(),
                network_type,
                label: None,
                priority: 0,
            },
            status,
            rtt_ms: None,
        }
    }

    #[test]
    fn encode_addresses_empty() {
        let result = encode_addresses(&[]);
        assert_eq!(result, "[]");
    }

    #[test]
    fn encode_addresses_single() {
        let addrs = vec![make_probed(
            "ws://1.2.3.4:8080/ws",
            NetworkType::Lan,
            AddressStatus::Unknown,
        )];
        let result = encode_addresses(&addrs);
        assert!(result.contains("ws://1.2.3.4:8080/ws"));
        assert!(result.contains("lan"));
    }

    #[test]
    fn decode_addresses_empty_string() {
        let result = decode_addresses("");
        assert!(result.is_empty());
    }

    #[test]
    fn decode_addresses_whitespace() {
        let result = decode_addresses("   ");
        assert!(result.is_empty());
    }

    #[test]
    fn decode_addresses_empty_json_array() {
        let result = decode_addresses("[]");
        assert!(result.is_empty());
    }

    #[test]
    fn decode_addresses_malformed_returns_empty() {
        let result = decode_addresses("not valid json");
        assert!(result.is_empty());
    }

    #[test]
    fn decode_addresses_round_trip() {
        let original = vec![make_probed(
            "ws://1.2.3.4:8080/ws",
            NetworkType::Lan,
            AddressStatus::Reachable,
        )];
        let encoded = encode_addresses(&original);
        let decoded = decode_addresses(&encoded);
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].address.url, "ws://1.2.3.4:8080/ws");
        assert_eq!(decoded[0].address.network_type, NetworkType::Lan);
        // Status is reset to Unknown on decode
        assert_eq!(decoded[0].status, AddressStatus::Unknown);
        assert!(decoded[0].rtt_ms.is_none());
    }

    #[test]
    fn build_probed_addresses_from_legacy() {
        let result = build_probed_addresses(vec![], "192.168.1.1", 8080, None);
        assert!(!result.is_empty());
        assert!(result[0].address.url.contains("192.168.1.1"));
    }

    #[test]
    fn build_probed_addresses_with_connect_url() {
        let result = build_probed_addresses(
            vec![],
            "192.168.1.1",
            8080,
            Some("wss://public.example.com/ws"),
        );
        assert!(!result.is_empty());
    }

    #[test]
    fn legacy_agent_address_prefers_tunnel() {
        let addrs = vec![
            make_probed(
                "ws://lan:8080/ws",
                NetworkType::Lan,
                AddressStatus::Reachable,
            ),
            make_probed(
                "wss://tunnel.example.com/ws",
                NetworkType::Tunnel,
                AddressStatus::Unknown,
            ),
        ];
        let result = legacy_agent_address(&addrs);
        assert_eq!(result, Some("wss://tunnel.example.com/ws".to_string()));
    }

    #[test]
    fn legacy_agent_address_prefers_reachable() {
        let addrs = vec![
            make_probed(
                "ws://unknown:8080/ws",
                NetworkType::Lan,
                AddressStatus::Unknown,
            ),
            make_probed(
                "ws://reachable:8080/ws",
                NetworkType::Lan,
                AddressStatus::Reachable,
            ),
        ];
        let result = legacy_agent_address(&addrs);
        assert_eq!(result, Some("ws://reachable:8080/ws".to_string()));
    }

    #[test]
    fn legacy_agent_address_falls_back_to_first() {
        let addrs = vec![
            make_probed(
                "ws://first:8080/ws",
                NetworkType::Lan,
                AddressStatus::Unknown,
            ),
            make_probed(
                "ws://second:8080/ws",
                NetworkType::Lan,
                AddressStatus::Unknown,
            ),
        ];
        let result = legacy_agent_address(&addrs);
        assert_eq!(result, Some("ws://first:8080/ws".to_string()));
    }

    #[test]
    fn legacy_agent_address_empty_list() {
        let result = legacy_agent_address(&[]);
        assert!(result.is_none());
    }
}
