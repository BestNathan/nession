//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{warn, info, ConnectionHandler, ProtocolMessage, HandlerAction, AgentTerminalResizePayload, ServerTerminalResizePayload, current_timestamp};

impl ConnectionHandler {
    pub(super) async fn handle_agent_terminal_resize(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let value = msg.payload;
        let Some(agent_id) = self
            .authorized_agent_id(&value, "server.agent.terminal-resize")
            .await
        else {
            return Ok(HandlerAction::Reply(None));
        };
        let payload: AgentTerminalResizePayload = match serde_json::from_value(value) {
            Ok(p) => p,
            Err(e) => {
                warn!("agent.terminal.resize with invalid payload: {}", e);
                return Ok(HandlerAction::Reply(None));
            }
        };

        // `agent_id:` rather than a split, so that whatever a session name
        // contains cannot change which agent the id is attributed to.
        if !payload.session_id.starts_with(&format!("{agent_id}:")) {
            warn!(
                "agent.terminal.resize from agent '{agent_id}' for session '{}', which is \
                 not one of its own; refusing",
                payload.session_id
            );
            return Ok(HandlerAction::Reply(None));
        }

        info!(
            "Terminal resize for session {}: {}x{}",
            payload.session_id, payload.cols, payload.rows
        );

        let server_payload = ServerTerminalResizePayload {
            session_id: payload.session_id.clone(),
            cols: payload.cols,
            rows: payload.rows,
        };
        let broadcast_msg = serde_json::json!({
            "msg_type": "terminal.resize",
            "id": uuid::Uuid::new_v4().to_string(),
            "timestamp": current_timestamp(),
            "payload": server_payload,
        });

        let sent = self
            .client_registry
            .broadcast(&payload.session_id, broadcast_msg.to_string())
            .await;

        if sent > 0 {
            info!(
                "Broadcast terminal resize to {} client(s) for session {}",
                sent, payload.session_id
            );
        }

        Ok(HandlerAction::Reply(None))
    }
}
