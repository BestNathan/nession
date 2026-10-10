//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{info, warn, ConnectionHandler, HandlerAction, ProtocolMessage};

impl ConnectionHandler {
    /// Handle `server.agent.command-response` — resolve a pending command.
    pub(super) async fn handle_agent_command_response(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let agent_id = match &self.registered_agent_id {
            Some(id) => id.clone(),
            None => {
                warn!("server.agent.command-response from unregistered connection");
                return Ok(HandlerAction::Reply(None));
            }
        };

        let request_id = msg
            .payload
            .get("request_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if request_id.is_empty() {
            warn!("server.agent.command-response missing request_id");
            return Ok(HandlerAction::Reply(None));
        }

        info!(
            "Received command response from agent {}: request_id={}, command={}",
            agent_id,
            request_id,
            msg.payload
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        );

        self.command_broker
            .resolve_command(&agent_id, &request_id, msg.payload)
            .await;

        Ok(HandlerAction::Reply(None))
    }
}
