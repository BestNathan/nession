//! `server.mcp.endpoint` (#3600).
//!
//! One versioned Server Protocol Unit. Route identity, version and execution
//! policy are owned by routes.rs.
//!
//! The answer is the configuration this Server applied at startup, not a probe
//! and not a guess at a public URL. Whether the endpoint is actually reachable
//! from a particular client is that client's question; the Claude MCP connect
//! flow answers it with its own bounded handshake.

use super::{current_timestamp, json, ConnectionHandler, HandlerAction, ProtocolMessage, WsFrame};

impl ConnectionHandler {
    /// Handle `server.mcp.endpoint` — whether this Server mounted `/mcp`, where,
    /// and which inbound credential model applies.
    pub(super) async fn handle_client_mcp_endpoint(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        Ok(HandlerAction::Reply(Some(WsFrame::Text(
            json!({
                "msg_type": "server.mcp.endpoint",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": {
                    "enabled": self.config.mcp_enabled,
                    "path": self.config.mcp_path,
                    // The Server's embedded endpoint verifies the Server's
                    // `auth_token`. An Agent token is refused there, so a
                    // client must provision the Server token into the Session's
                    // environment; this answer never carries it.
                    "auth": "host_token",
                }
            })
            .to_string(),
        ))))
    }
}
