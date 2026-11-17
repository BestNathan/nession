//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    extract_ip_from_url, info, AgentAddressUpdatePayload, ConnectionHandler, HandlerAction,
    ProtocolMessage,
};

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

        // The identity check above can pass while a newer connection registers
        // before this read-modify-write begins. Take the Agent's registration
        // gate and re-verify the generation, and keep the guard until the write
        // is done: otherwise a successor's registration can publish in that
        // window and this stale snapshot would replace its whole row, including
        // its Agent Token (#3723).
        let Some(_current) = self
            .command_broker
            .begin_address_update(&agent_id, self.connection_generation)
            .await
        else {
            info!(
                "agent.address_update for agent '{}' came from a superseded connection; refusing",
                agent_id
            );
            return Ok(HandlerAction::Reply(None));
        };

        let Some(agent) = self.agent_registry.get(&agent_id).await else {
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
        let address_count = addresses.len();
        let ip_address = primary_ip.unwrap_or_else(|| agent.ip_address.clone());

        if !self
            .agent_registry
            .apply_address_update(&agent_id, addresses, ip_address.clone())
            .await
        {
            info!(
                "agent.address_update for unknown agent '{}'; ignoring",
                agent_id
            );
            return Ok(HandlerAction::Reply(None));
        }

        info!(
            "Updated {} address(es) for agent {} (primary ip: {})",
            address_count, agent_id, ip_address,
        );

        Ok(HandlerAction::Reply(None))
    }
}
