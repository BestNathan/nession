use crate::db::Database;
use chrono::{DateTime, Utc};
use nession_protocol::contracts::agent::v1::{
    AddressStatus, AgentAddress, AgentMetadata, NetworkType, ProbedAddress,
};
use nession_protocol::ProtocolManifest;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, OwnedMutexGuard, RwLock};

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
    /// What this agent reported it can serve, from its own composition
    /// (`#678`).
    ///
    /// **Not persisted**, deliberately. The manifest describes what an agent can
    /// serve *now*, and an agent that is not connected can serve nothing — a
    /// stored copy would let this server claim support on behalf of a process
    /// that is not running.
    ///
    /// `None` is now only ever a **straggler**: registration refuses an agent
    /// that advertises nothing (`#678` is a breaking upgrade — a peer this
    /// server cannot route for is turned away at the door rather than relayed
    /// to on a guess), so a missing manifest here means the agent registered
    /// before this server was upgraded and has not reconnected since. The relay
    /// refuses those too.
    pub protocol_manifest: Option<ProtocolManifest>,
    /// The durable Agent Token synced on this registration (#3440).
    ///
    /// **Memory only.** Never persisted, never serialized into an agent view,
    /// never logged (`SecretString` redacts `Debug`). `None` means this Agent
    /// registered before the field existed or omitted it; attach refuses P2P
    /// with a clear reason until a re-registration supplies one. A stale
    /// registration cannot overwrite it: writes happen while the registration
    /// guard is held, and `register` replaces the whole record atomically.
    pub agent_token: Option<nession_common::SecretString>,
    /// Monotonic registration generation, assigned by
    /// [`AgentRegistry::register`].
    ///
    /// A probe sweep snapshots this beside the address list and carries it
    /// back with each result. A probe that completes after the Agent
    /// re-registered must not write into the successor's fresh status: the
    /// result would match the same URL but describe a registration that no
    /// longer exists (#2839). Callers constructing an `AgentInfo` for
    /// registration may leave this at zero — `register` overwrites it.
    pub probe_generation: u64,
    /// Monotonic **offline episode** generation, assigned by
    /// [`AgentRegistry::check_offline_agents`].
    ///
    /// Every Online→Offline transition opens a new episode and increments this.
    /// The grace-cleanup task captures the episode it was scheduled for and must
    /// claim that same episode again before removing anything, so work left over
    /// from an earlier offline interval cannot act on a later one (#2997).
    ///
    /// Like `probe_generation`, this is monotonic for the whole Agent lifetime:
    /// `register` preserves the current value rather than resetting it, because
    /// a reset would make an older cleanup's episode id current again.
    pub offline_generation: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentStatus {
    Online,
    Offline,
    Degraded,
}

/// One Agent's Online→Offline transition, captured by the heartbeat sweep.
///
/// The sweep opens a new offline episode for each transition and hands this to
/// the grace-cleanup task. The task must claim the same episode again it wakes,
/// so cleanup scheduled for an earlier episode cannot remove Sessions belonging
/// to a later one (#2997).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfflineTransition {
    pub agent_id: String,
    /// The offline episode this transition opened; see
    /// [`AgentInfo::offline_generation`].
    pub offline_generation: u64,
}

/// Proof that an expired offline episode is still the Agent's current one, and
/// that no heartbeat or registration can make it current again while this guard
/// lives.
///
/// Produced by [`AgentRegistry::begin_offline_cleanup`]; the registry's per-Agent
/// liveness gate stays held until the guard is dropped, which is what makes the
/// eligibility check and the destructive removal one ordered transition.
pub struct OfflineCleanupGuard {
    _gate: OwnedMutexGuard<()>,
}

/// One Agent's probe work, captured with the registration generation it
/// belongs to.
///
/// The generation travels with the URLs so a result cannot be applied to a
/// registration that replaced the one the sweep observed (#2839).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeTarget {
    pub agent_id: String,
    pub generation: u64,
    pub urls: Vec<String>,
}

pub struct AgentRegistry {
    agents: Arc<RwLock<HashMap<String, AgentInfo>>>,
    heartbeat_timeout_secs: u64,
    db: Arc<Database>,
    /// One gate per Agent, ordering the transitions that decide which offline
    /// episode the Agent is in: registration and heartbeat recovery (which make
    /// it Online) and expired-episode cleanup (which acts on it while Offline).
    ///
    /// Kept beside the records for the same reason `CommandBroker` keeps its
    /// registration gates beside its own: the map lock is held only long enough
    /// to find the gate, never across the state it orders. A cleanup that holds
    /// a gate keeps its episode current until the guard is dropped, so a status
    /// check alone is not what authorizes removal (#2997).
    liveness_gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl AgentRegistry {
    pub fn new(heartbeat_timeout_secs: u64, db: Arc<Database>) -> Self {
        Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
            heartbeat_timeout_secs,
            db,
            liveness_gates: Mutex::new(HashMap::new()),
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
                            image_tag: String::new(),
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
                        // Restored agents have no manifest until they register
                        // again — see the field's note on why it is not stored.
                        protocol_manifest: None,
                        // A restored Agent has no token state until it
                        // re-registers; attach refuses P2P until then.
                        agent_token: None,
                        // Zero until the first live registration; a restored
                        // Agent is not a registration a stale probe could
                        // overwrite.
                        probe_generation: 0,
                        // No offline episode has been opened in this process.
                        offline_generation: 0,
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

    /// Evict the cached Agent Token for one Agent (#3440).
    ///
    /// Called when the owning control connection ends: the token state belongs
    /// to the registration generation, and a later attach must refuse clearly
    /// until the Agent registers again rather than hand out a value this Server
    /// can no longer vouch for. A stale connection's release is refused by the
    /// command broker, so it cannot evict its successor's token.
    pub async fn clear_agent_token(&self, agent_id: &str) {
        let mut agents = self.agents.write().await;
        if let Some(info) = agents.get_mut(agent_id) {
            info.agent_token = None;
        }
    }

    pub async fn register(&self, mut info: AgentInfo) {
        // A registration is an Online transition, so it shares the Agent's
        // liveness gate with heartbeat recovery and expired-episode cleanup
        // (#2997): cleanup either sees this registration and stands down, or
        // finishes before it begins applying, and can never remove state across
        // the transition. The gate covers the SQLite write because that write is
        // part of what the registration publishes.
        let gate = self.liveness_gate(&info.agent_id).await;
        let _liveness = gate.lock_owned().await;

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
        // Assigned under the same write lock as the insertion, so the
        // generation a probe snapshot reads and the addresses it read with it
        // always belong to the same registration.
        //
        // The offline episode counter is likewise carried forward rather than
        // reset: it is monotonic for the whole Agent lifetime, so a registration
        // that replaces this row cannot make an older cleanup's episode id
        // current again (#2997).
        let (probe_generation, offline_generation) =
            agents.get(&info.agent_id).map_or((1, 0), |current| {
                (
                    current.probe_generation.saturating_add(1),
                    current.offline_generation,
                )
            });
        info.probe_generation = probe_generation;
        info.offline_generation = offline_generation;
        agents.insert(info.agent_id.clone(), info);
    }

    /// Update heartbeat timestamp and session counts for an agent.
    /// Returns `true` if a **meaningful** field changed (status, session_count,
    /// active_sessions) — i.e. the UI should re-render. Returns `false` when
    /// only `last_heartbeat` was touched (no-op for dashboard clients).
    pub async fn update_heartbeat(
        &self,
        agent_id: &str,
        session_count: u32,
        active_sessions: u32,
    ) -> bool {
        // A heartbeat is the Online transition. Ordering it against the
        // expired-episode cleanup claim (#2997) means a heartbeat that restores
        // a Session-bearing Agent either lands before cleanup (which then stands
        // down) or after it has finished — never in the middle of the removal.
        let gate = self.liveness_gate(agent_id).await;
        let _liveness = gate.lock_owned().await;

        let mut agents = self.agents.write().await;
        if let Some(agent) = agents.get_mut(agent_id) {
            let status_before = agent.status.clone();
            let sessions_before = agent.session_count;
            let active_before = agent.active_sessions;

            agent.last_heartbeat = Utc::now();
            agent.status = AgentStatus::Online;
            agent.session_count = session_count;
            agent.active_sessions = active_sessions;

            // Only signal a meaningful change — timestamp-only updates don't
            // need to trigger a broadcast to every web client.
            status_before != AgentStatus::Online
                || sessions_before != session_count
                || active_before != active_sessions
        } else {
            false
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

    /// Snapshot of the (agent_id, registration generation, address URLs) work
    /// one sweep should dial. Cloned out so the probe runs without holding the
    /// registry lock.
    pub async fn list_probe_targets(&self) -> Vec<ProbeTarget> {
        let agents = self.agents.read().await;
        agents
            .values()
            .map(|a| ProbeTarget {
                agent_id: a.agent_id.clone(),
                generation: a.probe_generation,
                urls: a.addresses.iter().map(|p| p.address.url.clone()).collect(),
            })
            .collect()
    }

    /// Record a probe result for one of an Agent's addresses (matched by URL).
    ///
    /// Returns `false` — and writes nothing — when the Agent or the address no
    /// longer exists, **or** when `generation` is not the one that was current
    /// when the sweep snapshotted it. The last case is a delayed result from a
    /// registration a newer one has replaced: the URL may match, but the status
    /// belongs to an Agent incarnation that is gone (#2839).
    pub async fn update_address_status(
        &self,
        agent_id: &str,
        generation: u64,
        url: &str,
        status: AddressStatus,
        rtt_ms: Option<u64>,
    ) -> bool {
        let mut agents = self.agents.write().await;
        let Some(agent) = agents.get_mut(agent_id) else {
            return false;
        };
        if agent.probe_generation != generation {
            return false;
        }
        for probed in &mut agent.addresses {
            if probed.address.url == url {
                probed.status = status;
                probed.rtt_ms = rtt_ms;
                return true;
            }
        }
        false
    }

    /// Mark Agents that have missed their heartbeat window as Offline.
    ///
    /// Every Online→Offline transition opens a new offline episode and gets a
    /// monotonic generation. The grace-cleanup task is bound to that generation,
    /// so work scheduled by an earlier episode cannot act on a later one
    /// (#2997).
    pub async fn check_offline_agents(&self) -> Vec<OfflineTransition> {
        let mut agents = self.agents.write().await;
        let now = Utc::now();
        let mut offline = vec![];

        for (agent_id, agent) in agents.iter_mut() {
            if agent.status == AgentStatus::Online {
                let elapsed = (now - agent.last_heartbeat).num_seconds().unsigned_abs();
                if elapsed > self.heartbeat_timeout_secs {
                    agent.status = AgentStatus::Offline;
                    agent.offline_generation = agent.offline_generation.saturating_add(1);
                    offline.push(OfflineTransition {
                        agent_id: agent_id.clone(),
                        offline_generation: agent.offline_generation,
                    });
                }
            }
        }

        offline
    }

    /// Claim the expired offline episode `offline_generation` for destructive
    /// cleanup.
    ///
    /// Succeeds only while the Agent is still in that episode: `Offline`, with
    /// the generation the sweep recorded. The returned guard holds the Agent's
    /// liveness gate until dropped, so no heartbeat or registration can turn the
    /// Agent Online between this check and the removal that follows — the check
    /// and the destructive boundary are one ordered transition (#2997).
    ///
    /// `None` means the episode is over (the Agent recovered, re-registered, or
    /// a later offline interval began) and nothing may be removed.
    pub async fn begin_offline_cleanup(
        &self,
        agent_id: &str,
        offline_generation: u64,
    ) -> Option<OfflineCleanupGuard> {
        let gate = self.liveness_gate(agent_id).await;
        let gate = gate.lock_owned().await;
        {
            let agents = self.agents.read().await;
            let agent = agents.get(agent_id)?;
            if agent.status != AgentStatus::Offline
                || agent.offline_generation != offline_generation
            {
                return None;
            }
        }
        Some(OfflineCleanupGuard { _gate: gate })
    }
}

/// Proof that an Agent deletion holds its liveness gate.
///
/// The gate is the same one [`AgentRegistry::register`] and heartbeat recovery
/// take, so the Offline revalidation and every destructive write that follows
/// are one ordered transition: a registration or heartbeat either lands before
/// the check (and the claim returns [`AgentDeleteClaim::NotOffline`]) or waits
/// until the Agent row is gone.
pub struct AgentDeletionGuard {
    _gate: OwnedMutexGuard<()>,
}

/// The result of claiming an Agent for deletion.
pub enum AgentDeleteClaim {
    /// The Agent is Offline and the caller may remove it while holding the
    /// guard.
    Claimed(AgentDeletionGuard),
    NotFound,
    /// The Agent exists but is not Offline; the carried status is the one
    /// observed under the gate.
    NotOffline(AgentStatus),
}

impl AgentRegistry {
    /// Claim `agent_id` for deletion.
    ///
    /// The returned guard holds the Agent's liveness gate until dropped; the
    /// caller must keep it alive across the database, registry, Session,
    /// Environment and Broker removals. This is deliberately not a plain status
    /// check: a check alone is a TOCTOU in which a registration can make the
    /// Agent Online between the check and the first destructive write.
    pub async fn begin_agent_deletion(&self, agent_id: &str) -> AgentDeleteClaim {
        let gate = self.liveness_gate(agent_id).await;
        let gate = gate.lock_owned().await;
        let status = {
            let agents = self.agents.read().await;
            agents.get(agent_id).map(|agent| agent.status.clone())
        };
        match status {
            None => AgentDeleteClaim::NotFound,
            Some(AgentStatus::Offline) => {
                AgentDeleteClaim::Claimed(AgentDeletionGuard { _gate: gate })
            }
            Some(status) => AgentDeleteClaim::NotOffline(status),
        }
    }

    /// The per-Agent gate ordering liveness transitions.
    ///
    /// Looked up (and created on first use) without holding the map lock across
    /// the wait on the gate itself, so unrelated Agents never serialize on one
    /// another. The entries live as long as the Agent row (plus the lifetime of
    /// any guard already handed out); `unregister` drops the entry with the row.
    async fn liveness_gate(&self, agent_id: &str) -> Arc<Mutex<()>> {
        let mut gates = self.liveness_gates.lock().await;
        Arc::clone(gates.entry(agent_id.to_string()).or_default())
    }

    pub async fn unregister(&self, agent_id: &str) {
        // The gate belongs to the Agent row: an id that comes back starts a new
        // episode history and must not inherit a claim from the previous
        // incarnation.
        self.liveness_gates.lock().await.remove(agent_id);
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

/// The Server-owned identity of a dialable Agent endpoint (#2652).
///
/// Two spellings name the same endpoint only when scheme, host, port and path
/// agree. Userinfo, query and fragment are not part of an Agent endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentEndpointIdentity {
    scheme: String,
    host: String,
    port: u16,
    path: String,
}

fn endpoint_identity(url: &str) -> Option<AgentEndpointIdentity> {
    let parsed = url::Url::parse(url).ok()?;
    let scheme = parsed.scheme();
    if scheme != "ws" && scheme != "wss" {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    let port = parsed.port_or_known_default()?;
    let path = parsed.path();
    Some(AgentEndpointIdentity {
        scheme: scheme.to_string(),
        host,
        port,
        path: if path.is_empty() { "/" } else { path }.to_string(),
    })
}

/// The registered Agent endpoint a browser-supplied Relay URL names, if any.
///
/// The Server, not the browser, owns the endpoint set. A manual Relay route
/// may select one of the Agent's registered addresses (or its Server-owned
/// legacy address), but it may not introduce a host, port or path of its own:
/// that is the relay dial's trust boundary. The **registered** spelling is
/// returned, so the dial never uses the browser's bytes.
///
/// **Ambiguous spellings are refused, not normalized away.** A candidate
/// carrying userinfo, a query or a fragment is not an Agent endpoint. The
/// query is where the scoped credential rides, and admitting one here would
/// smuggle an arbitrary query into the dial that presents it.
#[must_use]
pub fn agent_bound_relay_url(
    agent: &AgentInfo,
    legacy_url: &str,
    candidate: &str,
) -> Option<String> {
    let parsed = url::Url::parse(candidate).ok()?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    let target = endpoint_identity(candidate)?;
    agent
        .addresses
        .iter()
        .map(|probed| probed.address.url.as_str())
        .chain(std::iter::once(legacy_url))
        .find(|url| endpoint_identity(url).as_ref() == Some(&target))
        .map(str::to_string)
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

    fn make_agent(urls: &[&str]) -> AgentInfo {
        AgentInfo {
            agent_id: "agent-a".to_string(),
            hostname: "host".to_string(),
            ip_address: "10.0.0.5".to_string(),
            port: 19091,
            display_name: None,
            connect_url: None,
            addresses: urls
                .iter()
                .map(|url| make_probed(url, NetworkType::Lan, AddressStatus::Unknown))
                .collect(),
            registered_at: Utc::now(),
            last_heartbeat: Utc::now(),
            status: AgentStatus::Online,
            metadata: AgentMetadata {
                tmux_version: "3.3".to_string(),
                os_version: "linux".to_string(),
                nession_version: "0.1".to_string(),
                image_tag: "unknown".to_string(),
            },
            session_count: 0,
            active_sessions: 0,
            protocol_manifest: None,
            agent_token: None,
            probe_generation: 0,
            offline_generation: 0,
        }
    }

    #[test]
    fn relay_url_binds_registered_spellings_to_the_server_owned_string() {
        let agent = make_agent(&["ws://10.0.0.5:19091/ws", "wss://tunnel.example.com/ws"]);
        let legacy = "ws://10.0.0.5:19091/ws";

        assert_eq!(
            agent_bound_relay_url(&agent, legacy, "ws://10.0.0.5:19091/ws"),
            Some("ws://10.0.0.5:19091/ws".to_string())
        );
        // Scheme and host are case-insensitive, but the dial receives the
        // registered spelling rather than the browser's.
        assert_eq!(
            agent_bound_relay_url(&agent, legacy, "WS://10.0.0.5:19091/ws"),
            Some("ws://10.0.0.5:19091/ws".to_string())
        );
        assert_eq!(
            agent_bound_relay_url(&agent, legacy, "wss://TUNNEL.EXAMPLE.COM/ws"),
            Some("wss://tunnel.example.com/ws".to_string())
        );

        // A registered URL with a default port matches its explicit form.
        let default_port = make_agent(&["ws://host/ws"]);
        assert_eq!(
            agent_bound_relay_url(&default_port, "ws://host/ws", "ws://host:80/ws"),
            Some("ws://host/ws".to_string())
        );

        // The Server-owned legacy address is part of the Agent's endpoint set.
        let relay_only = make_agent(&[]);
        assert_eq!(
            agent_bound_relay_url(&relay_only, legacy, "ws://10.0.0.5:19091/ws"),
            Some(legacy.to_string())
        );
    }

    #[test]
    fn relay_url_rejects_foreign_and_ambiguous_endpoints() {
        let agent = make_agent(&["ws://10.0.0.5:19091/ws"]);
        let legacy = "ws://10.0.0.5:19091/ws";
        for candidate in [
            // Foreign or structurally different endpoints.
            "ws://evil.example/ws",
            "ws://10.0.0.5:19092/ws",
            "ws://10.0.0.5:19091/other",
            "ws://10.0.0.5:19091/ws/",
            "ws://10.0.0.5:19091/%77s",
            "wss://10.0.0.5:19091/ws",
            "http://10.0.0.5:19091/ws",
            // Forms that can make two targets look equivalent.
            "ws://user:pass@10.0.0.5:19091/ws",
            "ws://10.0.0.5:19091@evil.example/ws",
            "ws://10.0.0.5:19091/ws?token=stolen",
            "ws://10.0.0.5:19091/ws#fragment",
            "not a url",
        ] {
            assert_eq!(
                agent_bound_relay_url(&agent, legacy, candidate),
                None,
                "a manual relay URL must not bind: {candidate}"
            );
        }
    }
}
