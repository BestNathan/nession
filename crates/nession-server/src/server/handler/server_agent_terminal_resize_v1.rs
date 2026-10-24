//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{
    current_timestamp, info, warn, AgentTerminalResizePayload, ConnectionHandler, HandlerAction,
    ProtocolMessage,
};

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

        // The browser's Relay plugin subscribes to the canonical
        // agent.terminal.resize wire (and keys listeners by short session
        // name), just like its P2P counterpart. Historically this Server
        // emitted an unowned "terminal.resize" wire with a full agent:session
        // id; no Relay listener matched either value, so the observer never
        // received the current tmux grid (#2286, #2144).
        //
        // Authorization above already proved that this id begins with the
        // authenticated agent's exact prefix, including its ':' delimiter.
        // Do not split from the right: a session name may itself contain ':'.
        let agent_prefix = format!("{agent_id}:");
        let Some(session_name) = payload.session_id.strip_prefix(&agent_prefix) else {
            return Ok(HandlerAction::Reply(None));
        };
        let broadcast_msg = serde_json::json!({
            "msg_type": "agent.terminal.resize",
            "id": uuid::Uuid::new_v4().to_string(),
            "timestamp": current_timestamp(),
            "payload": {
                "session_name": session_name,
                "cols": payload.cols,
                "rows": payload.rows,
            },
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
