//! One versioned Server Protocol Unit.
//! Route identity, version and execution policy are owned by routes.rs.

use super::{json, reply_json, ConnectionHandler, HandlerAction, ProtocolMessage};

impl ConnectionHandler {
    pub(super) async fn handle_client_commands_remove(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(reply_json(
                &msg.id,
                "server.commands.remove",
                json!({ "success": false, "error": "Not authenticated" }),
            ));
        }
        let id = msg
            .payload
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        if id.is_empty() {
            return Ok(reply_json(
                &msg.id,
                "server.commands.remove",
                json!({ "success": false, "error": "id is required" }),
            ));
        }
        if let Err(e) = self.db.delete_quick_command(&id).await {
            return Ok(reply_json(
                &msg.id,
                "server.commands.remove",
                json!({ "success": false, "error": e.to_string() }),
            ));
        }
        self.web_client_registry.broadcast_commands_changed().await;
        Ok(reply_json(
            &msg.id,
            "server.commands.remove",
            json!({ "success": true }),
        ))
    }
}
