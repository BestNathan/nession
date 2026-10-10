//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{info, ConnectionHandler, ProtocolMessage, HandlerAction, AgentAddressUpdatePayload, extract_ip_from_url};

impl ConnectionHandler {
    /// Handle `agent.address_update` — update the agent's advertised
    /// addresses after a network change on the agent host.
    ///
    /// The agent it belongs to comes from the connection, not from the payload
    /// — see `authorized_agent_id`.
    pub(super) async fn handle_agent_address_update(
        &self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        // The identity is read from the raw payload, before it is consumed by
        // the typed parse below — the connection's registration is what decides
        // whose addresses these are, not the id in the body.
        let value = msg.payload;
        let Some(agent_id) = self
            .authorized_agent_id(&value, "server.agent.address-update")
            .await
        else {
            return Ok(HandlerAction::Reply(None));
        };
        let payload: AgentAddressUpdatePayload = serde_json::from_value(value)?;

        let Some(mut agent) = self.agent_registry.get(&agent_id).await else {
            info!(
                "agent.address_update from unknown agent '{}'; ignoring",
                agent_id
            );
            return Ok(HandlerAction::Reply(None));
        };

        // Extract a display IP from the first LAN address so the legacy
        // `ip_address` field (shown in the Web UI) stays in sync.
        let primary_ip = payload
            .addresses
            .iter()
            .find(|a| a.network_type == nession_protocol::contracts::agent::v1::NetworkType::Lan)
            .or_else(|| payload.addresses.first())
            .and_then(|a| extract_ip_from_url(&a.url));

        let addresses = crate::registry::build_probed_addresses(
            payload.addresses,
            primary_ip.as_deref().unwrap_or(&agent.ip_address),
            agent.port,
            agent.connect_url.as_deref(),
        );
        agent.addresses = addresses;
        if let Some(ip) = primary_ip {
            agent.ip_address = ip;
        }

        info!(
            "Updated {} address(es) for agent {} (primary ip: {})",
            agent.addresses.len(),
            agent_id,
            agent.ip_address,
        );

        self.agent_registry.register(agent).await;
        Ok(HandlerAction::Reply(None))
    }
}
