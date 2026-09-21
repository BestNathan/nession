//! The agent record as a Web client reads it.
//!
//! One function, because the field set is one contract.
//!
//! It was two hand-built `json!` blocks — `server.agent.list` in `handler.rs`
//! and the `agents.changed` push in `web_client_registry.rs` — and they had
//! already drifted: the push carried neither `protocols` nor
//! `metadata.image_tag`. Nothing failed, because nothing read either field off
//! a push. A client that had resolved a contract version from the list would
//! have lost it on the next connect/disconnect notification, and the only
//! symptom would have been calls quietly going out unversioned again — which
//! is exactly the pre-`#678` behaviour, so it looks like nothing is wrong.
//!
//! `broadcast_sessions_changed` already makes this argument for sessions: both
//! paths go through the same helper "so both paths always carry an identical
//! field set". This is that sentence, applied to agents.

use serde_json::json;

use crate::registry::{AgentInfo, AgentStatus};

/// One agent, as the Web receives it.
///
/// `protocols` is a key whose value may be `null`, never an absent key and
/// never an empty object. A client still has to tell "this server has no
/// manifest for that peer" from "that peer advertises an empty protocol set",
/// because they resolve differently — the first is unresolvable, the second is
/// a peer that serves nothing.
///
/// Registration now **refuses** an agent that advertises nothing, so `null`
/// here means one thing only: a straggler that registered before this server
/// was upgraded and has not reconnected since. The relay refuses those rather
/// than guessing, so the Web will show a peer whose calls all come back
/// `contract_not_supported` — which is the honest answer, and the reason the
/// key is worth keeping rather than collapsing to an empty object.
pub fn agent_json(a: &AgentInfo) -> serde_json::Value {
    json!({
        "agent_id": a.agent_id,
        "hostname": a.hostname,
        "display_name": a.display_name,
        "ip_address": a.ip_address,
        "port": a.port,
        "status": match a.status {
            AgentStatus::Online => "online",
            AgentStatus::Offline => "offline",
            AgentStatus::Degraded => "degraded",
        },
        "session_count": a.session_count,
        "active_sessions": a.active_sessions,
        "last_heartbeat": a.last_heartbeat.to_rfc3339(),
        "registered_at": a.registered_at.to_rfc3339(),
        "addresses": serde_json::to_value(&a.addresses).unwrap_or(json!([])),
        // What this agent reported it can serve (`#678`).
        //
        // Served from the agent list rather than a query of its own: this is
        // already the "discover agents" call the design's data flow names, so a
        // consumer resolving per target has the manifests in hand without a
        // second round trip per agent.
        "protocols": a.protocol_manifest.as_ref(),
        "metadata": {
            "nession_version": a.metadata.nession_version,
            "tmux_version": a.metadata.tmux_version,
            "os_version": a.metadata.os_version,
            "image_tag": a.metadata.image_tag,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nession_common::protocol::AgentMetadata;
    use nession_protocol::{ContractSupport, ContractVersion, ProtocolId, ProtocolManifest};
    use std::collections::BTreeMap;

    fn agent(manifest: Option<ProtocolManifest>) -> AgentInfo {
        AgentInfo {
            agent_id: "agent-a".to_string(),
            hostname: "host".to_string(),
            ip_address: "10.0.0.1".to_string(),
            port: 19091,
            display_name: Some("Agent A".to_string()),
            connect_url: None,
            addresses: vec![],
            registered_at: chrono::DateTime::from_timestamp(1_700_000_000, 0).unwrap(),
            last_heartbeat: chrono::DateTime::from_timestamp(1_700_000_100, 0).unwrap(),
            status: AgentStatus::Online,
            metadata: AgentMetadata {
                tmux_version: "3.4".to_string(),
                os_version: "Linux".to_string(),
                nession_version: "0.1.0".to_string(),
                image_tag: "abc1234".to_string(),
            },
            session_count: 2,
            active_sessions: 1,
            protocol_manifest: manifest,
        }
    }

    #[test]
    fn a_manifest_is_served_as_an_object() {
        let mut protocols = BTreeMap::new();
        protocols.insert(
            ProtocolId::new("git.status").unwrap(),
            ContractSupport::with_wire(vec![ContractVersion::V1], vec!["git.status".to_string()]),
        );
        let manifest = ProtocolManifest {
            provider: "agent-a".to_string(),
            protocols,
            software_version: None,
        };

        let json = agent_json(&agent(Some(manifest)));
        assert_eq!(json["protocols"]["provider"], "agent-a");
        assert_eq!(
            json["protocols"]["protocols"]["git.status"]["versions"][0],
            1
        );
    }

    #[test]
    fn a_peer_with_no_manifest_gets_null_and_not_a_missing_key() {
        // The distinction the client resolves on: `null` is a peer this server
        // has no manifest for, and an absent key would be one whose answer it
        // does not know. Collapsing them would make an unroutable straggler
        // look like a peer that serves nothing.
        //
        // Registration refuses an agent that advertises nothing, so this state
        // is a straggler that has not reconnected since the upgrade — but it is
        // still a state the server can be in, and the client still has to be
        // able to tell it apart.
        let json = agent_json(&agent(None));
        assert!(json.get("protocols").is_some(), "key must be present");
        assert!(json["protocols"].is_null(), "and must be null");
    }

    #[test]
    fn the_image_tag_travels_on_every_path() {
        // The field the `agents.changed` push used to drop. It is asserted
        // here rather than in two places because there is now one builder.
        let json = agent_json(&agent(None));
        assert!(json["metadata"]["image_tag"].is_string());
    }
}
