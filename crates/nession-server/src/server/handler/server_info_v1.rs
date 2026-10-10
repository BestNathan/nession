//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{json, ConnectionHandler, ProtocolMessage, HandlerAction, AgentStatus, Message, current_timestamp};

impl ConnectionHandler {
    /// Handle `server.info` — return server version, uptime, and stats.
    pub(super) async fn handle_client_server_info(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let agents = self.agent_registry.list().await;
        let online = agents
            .iter()
            .filter(|a| a.status == AgentStatus::Online)
            .count();
        let sessions = self.session_registry.list().await.len();

        Ok(HandlerAction::Reply(Some(Message::Text(
            json!({
                "msg_type": "server.info",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": {
                    "version": env!("CARGO_PKG_VERSION"),
                    "image_tag": option_env!("IMAGE_TAG").unwrap_or("dev"),
                    "uptime_seconds": crate::uptime_seconds(),
                    "agent_count": agents.len(),
                    "online_agent_count": online,
                    "session_count": sessions,
                    "build_time": option_env!("BUILD_TIME").unwrap_or("unknown"),
                    // What this server serves (`#678`). Derived from the same
                    // declaration that dispatches, so it cannot claim a unit
                    // this server does not answer.
                    "protocol_manifest": crate::protocol::server_manifest()?,
                }
            })
            .to_string(),
        ))))
    }
}
