//! `server.mcp.tools.list` — the validated Extension contribution manifest
//! (`#3778`). Route identity, version and policy are owned by `routes.rs`.

use super::{current_timestamp, ConnectionHandler, HandlerAction, ProtocolMessage, WsFrame};
use nession_protocol::contracts::mcp::v1::{McpToolManifest, McpToolsListResponse};
use serde_json::json;

impl ConnectionHandler {
    pub(super) async fn handle_client_mcp_tools_list(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(HandlerAction::Reply(Some(WsFrame::Text(
                json!({
                    "msg_type": "server.mcp.tools.list",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": { "status": "error", "message": "Not authenticated" }
                })
                .to_string(),
            ))));
        }
        // Liveness is deliberately absent: an offline Agent's Tools stay listed
        // and execution answers the truth for the named target. A Server that
        // cannot host contributions (test wiring only) answers an empty
        // manifest rather than failing the discovery call.
        let manifest = match self.extension_tools.as_ref() {
            Some(tools) => tools.manifest(),
            None => McpToolManifest::new(Vec::new()),
        };
        Ok(HandlerAction::Reply(Some(WsFrame::Text(
            json!({
                "msg_type": "server.mcp.tools.list",
                "id": msg.id,
                "timestamp": current_timestamp(),
                "payload": McpToolsListResponse { manifest },
            })
            .to_string(),
        ))))
    }
}
